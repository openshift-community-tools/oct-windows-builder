import { K8sModel, K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

export const DataVolumeModel: K8sModel = {
  apiVersion: 'v1beta1',
  apiGroup: 'cdi.kubevirt.io',
  kind: 'DataVolume',
  abbr: 'DV',
  label: 'DataVolume',
  labelPlural: 'DataVolumes',
  plural: 'datavolumes',
  namespaced: true,
};

export const DataSourceModel: K8sModel = {
  apiVersion: 'v1beta1',
  apiGroup: 'cdi.kubevirt.io',
  kind: 'DataSource',
  abbr: 'DS',
  label: 'DataSource',
  labelPlural: 'DataSources',
  plural: 'datasources',
  namespaced: true,
};

export const VirtualMachineModel: K8sModel = {
  apiVersion: 'v1',
  apiGroup: 'kubevirt.io',
  kind: 'VirtualMachine',
  abbr: 'VM',
  label: 'VirtualMachine',
  labelPlural: 'VirtualMachines',
  plural: 'virtualmachines',
  namespaced: true,
};

export const TemplateModel: K8sModel = {
  apiVersion: 'v1',
  apiGroup: 'template.openshift.io',
  kind: 'Template',
  abbr: 'TPL',
  label: 'Template',
  labelPlural: 'Templates',
  plural: 'templates',
  namespaced: true,
};

export const StorageClassModel: K8sModel = {
  apiVersion: 'v1',
  apiGroup: 'storage.k8s.io',
  kind: 'StorageClass',
  abbr: 'SC',
  label: 'StorageClass',
  labelPlural: 'StorageClasses',
  plural: 'storageclasses',
  namespaced: false,
};

/** OpenShift Virtualization's HyperConverged CR (holds the VM state storage class). */
export const HyperConvergedModel: K8sModel = {
  apiVersion: 'v1beta1',
  apiGroup: 'hco.kubevirt.io',
  kind: 'HyperConverged',
  abbr: 'HCO',
  label: 'HyperConverged',
  labelPlural: 'HyperConvergeds',
  plural: 'hyperconvergeds',
  namespaced: true,
};

export const StorageProfileModel: K8sModel = {
  apiVersion: 'v1beta1',
  apiGroup: 'cdi.kubevirt.io',
  kind: 'StorageProfile',
  abbr: 'SP',
  label: 'StorageProfile',
  labelPlural: 'StorageProfiles',
  plural: 'storageprofiles',
  namespaced: false,
};

export type HyperConvergedKind = K8sResourceCommon & {
  spec?: { storage?: { vmStateStorageClass?: string } };
};

/** CNV golden-image namespace — product identity, not a lab name. */
export const GOLDEN_IMAGE_NAMESPACE = 'openshift-virtualization-os-images';

/** CNV Windows Templates typically live here. */
export const TEMPLATE_NAMESPACE = 'openshift';

export const PLUGIN_NAMESPACE = 'oct-windows-builder';

export type DataVolumeKind = {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    storageClassName?: string;
    pvc?: {
      storageClassName?: string;
      resources?: { requests?: { storage?: string } };
    };
    storage?: {
      storageClassName?: string;
      resources?: { requests?: { storage?: string } };
    };
  };
  status?: {
    phase?: string;
    progress?: string;
    conditions?: Array<{ type?: string; status?: string; message?: string }>;
  };
};

export type DataSourceKind = {
  metadata: {
    name: string;
    namespace?: string;
  };
  status?: {
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
};

export function isDataSourceReady(ds: DataSourceKind): boolean {
  return (ds.status?.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True');
}

export type StorageClassKind = {
  metadata: {
    name: string;
    annotations?: Record<string, string>;
  };
  provisioner?: string;
  parameters?: Record<string, string>;
};

export type TemplateParameter = {
  name?: string;
  value?: string;
  description?: string;
};

export type TemplateKind = {
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  objects?: unknown[];
  parameters?: TemplateParameter[];
};

type K8sErrShape = {
  message?: string;
  json?: { message?: string; code?: number };
  status?: number;
  code?: number;
};

function asK8sErr(err: unknown): K8sErrShape | undefined {
  if (err == null || typeof err !== 'object') {
    return undefined;
  }
  return err as K8sErrShape;
}

export function getK8sErrorMessage(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  const obj = asK8sErr(err);
  if (!obj) return String(err);
  return obj.json?.message || obj.message || String(err);
}

export function getK8sErrorCode(err: unknown): number | undefined {
  const obj = asK8sErr(err);
  if (!obj) return undefined;
  return obj.json?.code ?? obj.status ?? obj.code;
}

export function isForbiddenError(err: unknown): boolean {
  if (err == null) return false;
  const code = getK8sErrorCode(err);
  if (code === 403) return true;
  const msg = getK8sErrorMessage(err).toLowerCase();
  return msg.includes('forbidden') || msg.includes('cannot list resource');
}

export function isMissingCrdError(err: unknown): boolean {
  if (err == null) return false;
  const code = getK8sErrorCode(err);
  if (code === 404) return true;
  const msg = getK8sErrorMessage(err).toLowerCase();
  return (
    msg.includes('could not find the requested resource') ||
    msg.includes('no matches for kind') ||
    msg.includes('the server could not find the requested resource') ||
    msg.includes('model does not exist')
  );
}

/** True when the Console SDK has a discovered model (CRD installed). */
export function isDiscoveredModel(model: unknown): boolean {
  if (model == null) return false;
  if (typeof model !== 'object') return false;
  const rec = model as { kind?: string; get?: (k: string) => unknown };
  if (typeof rec.kind === 'string' && rec.kind.length > 0) return true;
  if (typeof rec.get === 'function') {
    const kind = rec.get('kind');
    return typeof kind === 'string' && kind.length > 0;
  }
  return true;
}

const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function isValidDiskName(name: string): boolean {
  return name.length > 0 && name.length <= 50 && DNS1123.test(name);
}

export function dvStorageClass(dv: DataVolumeKind): string {
  return dv.spec?.storage?.storageClassName || dv.spec?.pvc?.storageClassName || '';
}

export function isDefaultStorageClass(sc: StorageClassKind): boolean {
  return sc.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true';
}

export function isWindowsTemplate(t: TemplateKind): boolean {
  const name = (t.metadata.name || '').toLowerCase();
  if (/^windows(\d+|2k\d+)/.test(name) || /^win(10|11|2k)/.test(name)) {
    return true;
  }
  const labels = t.metadata.labels || {};
  return Object.keys(labels).some((k) => k.startsWith('os.template.kubevirt.io/win'));
}

export function virtioImageFromTemplate(t: TemplateKind): string {
  const raw = JSON.stringify(t.objects || []);
  const virtioWin = raw.match(/"([^"]*virtio-win[^"]*)"/i);
  if (virtioWin) return virtioWin[1];
  const virtioDisk = raw.match(/"([^"]*virtio-container-disk[^"]*)"/i);
  return virtioDisk ? virtioDisk[1] : '';
}

export function phaseToUi(phase?: string): string {
  switch (phase) {
    case 'Succeeded':
      return 'Ready';
    case 'Failed':
      return 'Error';
    case 'Paused':
    case 'Pending':
    case 'WaitForFirstConsumer':
    case 'Unknown':
      return 'Pending';
    default:
      return phase || 'Pending';
  }
}
