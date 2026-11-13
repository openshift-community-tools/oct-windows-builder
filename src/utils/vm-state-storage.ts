/**
 * Pre-flight check for the storage class KubeVirt uses for VM state.
 *
 * Windows 11 (and other Windows templates with a persistent TPM or EFI) get a tiny
 * "persistent-state-for-<vm>" PVC, about 10 MiB. KubeVirt creates it on the
 * HyperConverged `spec.storage.vmStateStorageClass`, or on the cluster's default
 * StorageClass when that is unset. XFS cannot be formatted that small (minimum 300 MB),
 * so on an XFS filesystem class the VM never starts: the launcher pod stays in Init with
 * "format of disk ... failed ... data subvolume is too small".
 *
 * Pure module (no console SDK) so the decision can be tested on its own.
 */
import { StorageClassKind, isDefaultStorageClass } from './k8s-resources';

export type VmStateStorage = {
  /** Effective class name ('' when neither the HyperConverged setting nor a default exists). */
  className: string;
  /** Where it came from. */
  source: 'hyperconverged' | 'default' | 'none';
  /** Filesystem the class formats volumes with, when it says so. */
  fsType: string;
  /** True when VM state volumes can't be created on it (XFS). */
  broken: boolean;
  /** A class that can hold tiny filesystem volumes, to offer as the fix ('' when none). */
  suggestion: string;
};

const FSTYPE_KEYS = ['csi.storage.k8s.io/fstype', 'fsType', 'fstype', 'fs'];

export function storageClassFsType(sc?: StorageClassKind): string {
  const p = sc?.parameters || {};
  for (const k of FSTYPE_KEYS) {
    if (p[k]) return String(p[k]).toLowerCase();
  }
  return '';
}

/** Classes that never back a filesystem PVC (object buckets, static local volumes, NFS shares are fine but slow to bind). */
function unsuitable(sc: StorageClassKind): boolean {
  const prov = sc.provisioner || '';
  return /noobaa\.io\/obc|ceph\.rook\.io\/bucket|no-provisioner/.test(prov);
}

/** Prefer an explicit ext4 class, then the default virtualization class, then Ceph RBD. */
function pickSuggestion(classes: StorageClassKind[], current: string): string {
  const candidates = classes.filter(
    (sc) => sc.metadata.name !== current && !unsuitable(sc) && storageClassFsType(sc) !== 'xfs',
  );
  const score = (sc: StorageClassKind): number => {
    const fs = storageClassFsType(sc);
    let s = 0;
    if (fs === 'ext4') s += 4;
    if (sc.metadata.annotations?.['storageclass.kubevirt.io/is-default-virt-class'] === 'true') s += 2;
    if (isDefaultStorageClass(sc)) s += 2;
    if (/rbd\.csi\.ceph\.com/.test(sc.provisioner || '')) s += 1;
    if (/replica2|4k/.test(sc.metadata.name)) s -= 1;
    return s;
  };
  const ranked = candidates
    .map((sc) => ({ sc, s: score(sc) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.sc.metadata.name.localeCompare(b.sc.metadata.name));
  return ranked[0]?.sc.metadata.name || '';
}

export function evaluateVmStateStorage(hcoSetting: string | undefined, classes: StorageClassKind[]): VmStateStorage {
  const setting = (hcoSetting || '').trim();
  const def = classes.find(isDefaultStorageClass);
  const className = setting || def?.metadata.name || '';
  const source: VmStateStorage['source'] = setting ? 'hyperconverged' : def ? 'default' : 'none';
  const sc = classes.find((c) => c.metadata.name === className);
  const fsType = storageClassFsType(sc);
  const broken = fsType === 'xfs';
  return { className, source, fsType, broken, suggestion: broken ? pickSuggestion(classes, className) : '' };
}

/** The oc command an admin can run instead of the button. */
export function vmStateStorageCommand(hcoNamespace: string, hcoName: string, className: string): string {
  return `oc patch hyperconverged ${hcoName} -n ${hcoNamespace} --type merge -p '{"spec":{"storage":{"vmStateStorageClass":"${className}"}}}'`;
}
