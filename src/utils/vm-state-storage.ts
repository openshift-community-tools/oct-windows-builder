/**
 * Pre-flight check for the storage class KubeVirt uses for VM state.
 *
 * Windows 11 (and other Windows templates with a persistent TPM or EFI) get a tiny
 * "persistent-state-for-<vm>" PVC, about 10 MiB, always in Filesystem mode. KubeVirt
 * picks its class like this (KubeVirt 1.8, OpenShift Virtualization 4.22):
 *   1. HyperConverged spec.storage.vmStateStorageClass (KubeVirt vmStateStorageClass),
 *   2. else the default virtualization class (storageclass.kubevirt.io/is-default-virt-class),
 *   3. else the default class (storageclass.kubernetes.io/is-default-class).
 * XFS cannot be formatted that small (minimum 300 MB), so on an XFS class the VM never
 * starts: the launcher pod stays in Init with "data subvolume is too small".
 *
 * Fixes: point VM state at a class that formats small volumes (ext4, CephFS, NFS), or keep
 * the XFS class and annotate its StorageProfile with cdi.kubevirt.io/minimumSupportedPvcSize
 * so CDI rounds the request up to a size XFS can format.
 *
 * Pure module (no console SDK) so the decision is unit-tested.
 */
import { StorageClassKind } from './k8s-resources';

export const DEFAULT_CLASS_ANNOTATION = 'storageclass.kubernetes.io/is-default-class';
export const DEFAULT_VIRT_CLASS_ANNOTATION = 'storageclass.kubevirt.io/is-default-virt-class';
export const MIN_PVC_SIZE_ANNOTATION = 'cdi.kubevirt.io/minimumSupportedPvcSize';
export const XFS_MIN_PVC_SIZE = '300Mi';

export type StorageProfileKind = {
  metadata: { name: string; annotations?: Record<string, string> };
  status?: { claimPropertySets?: Array<{ accessModes?: string[]; volumeMode?: string }> };
};

export type VmStateStorage = {
  /** Effective class ('' when nothing is set and no default exists). */
  className: string;
  source: 'hyperconverged' | 'default-virt' | 'default' | 'none';
  /** Other classes tied as default at the same level (KubeVirt may pick any of them). */
  tiedWith: string[];
  fsType: string;
  /** VM state volumes can't be created: an XFS class without a minimum PVC size. */
  broken: boolean;
  /** A class that can hold tiny Filesystem volumes ('' when none). */
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

const isTrue = (sc: StorageClassKind, ann: string) => sc.metadata.annotations?.[ann] === 'true';

/** Parses Kubernetes quantities like 300Mi, 1Gi, 500M into bytes (0 when unknown). */
export function quantityBytes(q?: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGTPE]i?)?$/.exec((q || '').trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2] || '';
  const pow: Record<string, number> = { K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 };
  if (!unit) return n;
  const base = unit.endsWith('i') ? 1024 : 1000;
  return n * Math.pow(base, pow[unit[0]]);
}

/** XFS is fine when the class's StorageProfile makes CDI request at least 300Mi. */
function xfsSafe(profile?: StorageProfileKind): boolean {
  return quantityBytes(profile?.metadata.annotations?.[MIN_PVC_SIZE_ANNOTATION]) >= quantityBytes(XFS_MIN_PVC_SIZE);
}

/** The StorageProfile offers a Filesystem claim, so a state volume can bind. */
function bindsFilesystem(profile?: StorageProfileKind): boolean {
  return (profile?.status?.claimPropertySets || []).some(
    (p) => (p.volumeMode || 'Filesystem') === 'Filesystem' && (p.accessModes || []).length > 0,
  );
}

/** Filesystem the class formats with, including drivers whose default is known. */
function effectiveFs(sc: StorageClassKind): string {
  const fs = storageClassFsType(sc);
  if (fs) return fs;
  const prov = sc.provisioner || '';
  if (/cephfs\.csi\.ceph\.com/.test(prov)) return 'cephfs';
  if (/nfs/i.test(prov)) return 'nfs';
  if (/rbd\.csi\.ceph\.com/.test(prov)) return 'ext4'; // ceph-csi RBD default
  return '';
}

function pickSuggestion(classes: StorageClassKind[], profiles: StorageProfileKind[], current: string): string {
  const profileOf = (name: string) => profiles.find((p) => p.metadata.name === name);
  const fsScore: Record<string, number> = { ext4: 3, cephfs: 2, nfs: 1 };
  const ranked = classes
    .filter((sc) => sc.metadata.name !== current && bindsFilesystem(profileOf(sc.metadata.name)))
    .map((sc) => {
      const base = fsScore[effectiveFs(sc)] || 0;
      const bonus = (isTrue(sc, DEFAULT_VIRT_CLASS_ANNOTATION) ? 0.5 : 0) + (isTrue(sc, DEFAULT_CLASS_ANNOTATION) ? 0.25 : 0);
      return { sc, s: base ? base + bonus : 0 };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.sc.metadata.name.localeCompare(b.sc.metadata.name));
  return ranked[0]?.sc.metadata.name || '';
}

export function evaluateVmStateStorage(
  hcoSetting: string | undefined,
  classes: StorageClassKind[],
  profiles: StorageProfileKind[] = [],
): VmStateStorage {
  const setting = (hcoSetting || '').trim();
  let source: VmStateStorage['source'] = 'none';
  let candidates: string[] = [];
  if (setting) {
    source = 'hyperconverged';
    candidates = [setting];
  } else {
    const virt = classes.filter((sc) => isTrue(sc, DEFAULT_VIRT_CLASS_ANNOTATION)).map((sc) => sc.metadata.name);
    const def = classes.filter((sc) => isTrue(sc, DEFAULT_CLASS_ANNOTATION)).map((sc) => sc.metadata.name);
    if (virt.length) {
      source = 'default-virt';
      candidates = virt;
    } else if (def.length) {
      source = 'default';
      candidates = def;
    }
  }
  const brokenOne = (name: string) => {
    const sc = classes.find((c) => c.metadata.name === name);
    return storageClassFsType(sc) === 'xfs' && !xfsSafe(profiles.find((p) => p.metadata.name === name));
  };
  // With several defaults KubeVirt may pick any of them: report the first broken one.
  const className = candidates.find(brokenOne) || candidates[0] || '';
  const sc = classes.find((c) => c.metadata.name === className);
  const broken = Boolean(className) && brokenOne(className);
  return {
    className,
    source,
    tiedWith: candidates.filter((c) => c !== className),
    fsType: storageClassFsType(sc),
    broken,
    suggestion: broken ? pickSuggestion(classes, profiles, className) : '',
  };
}

export function vmStateStorageCommand(hcoNamespace: string, hcoName: string, className: string): string {
  return `oc patch hyperconverged ${hcoName} -n ${hcoNamespace} --type merge -p '{"spec":{"storage":{"vmStateStorageClass":"${className}"}}}'`;
}

export function minPvcSizeCommand(className: string): string {
  return `oc annotate storageprofile ${className} ${MIN_PVC_SIZE_ANNOTATION}=${XFS_MIN_PVC_SIZE} --overwrite`;
}
