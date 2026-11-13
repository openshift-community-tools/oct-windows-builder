import React, { FC, useMemo, useState } from 'react';
import { k8sPatch, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import { Alert, Button, ClipboardCopy } from '@patternfly/react-core';
import { HyperConvergedKind, HyperConvergedModel, StorageClassKind } from '../utils/k8s-resources';
import { evaluateVmStateStorage, vmStateStorageCommand } from '../utils/vm-state-storage';

const HCO_GVK = {
  group: HyperConvergedModel.apiGroup,
  version: HyperConvergedModel.apiVersion,
  kind: HyperConvergedModel.kind,
};

type Props = {
  storageClasses: StorageClassKind[];
  storageClassesLoaded: boolean;
};

/**
 * Pre-flight: Windows VMs with a persistent TPM/EFI (Windows 11, Server 2025) get a tiny
 * VM state PVC on the HyperConverged vmStateStorageClass (or the default class). On an XFS
 * class it can't be formatted and the VM never starts. Warn, and offer the fix.
 */
const VmStateStorageCheck: FC<Props> = ({ storageClasses, storageClassesLoaded }) => {
  const { t } = useTranslation('plugin__oct-windows-builder');
  const [hcos, hcoLoaded, hcoErr] = useK8sWatchResource<HyperConvergedKind[]>({
    groupVersionKind: HCO_GVK,
    isList: true,
    namespaced: false,
  });
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [applied, setApplied] = useState('');

  const hco = (hcos || [])[0];
  const result = useMemo(
    () => evaluateVmStateStorage(hco?.spec?.storage?.vmStateStorageClass, storageClasses),
    [hco, storageClasses],
  );

  // Users who can't read the HyperConverged CR, or clusters without it: nothing to say.
  if (!storageClassesLoaded || !hcoLoaded || hcoErr || !hco?.metadata?.name || !result.broken) {
    return applied ? (
      <Alert
        variant="success"
        isInline
        title={t('VM state now uses {{sc}}. New Windows VMs can start.', { sc: applied })}
      >
        {t('A VM that was already stuck: stop it, delete its persistent-state-for-<vm> PVC, and start it again.')}
      </Alert>
    ) : null;
  }

  const ns = hco.metadata.namespace || 'openshift-cnv';
  const name = hco.metadata.name;
  const fix = result.suggestion;

  const apply = async () => {
    setApplying(true);
    setApplyError('');
    try {
      const hasStorage = Boolean(hco.spec?.storage);
      await k8sPatch({
        model: HyperConvergedModel,
        resource: hco,
        data: hasStorage
          ? [{ op: 'add', path: '/spec/storage/vmStateStorageClass', value: fix }]
          : [{ op: 'add', path: '/spec/storage', value: { vmStateStorageClass: fix } }],
      });
      setApplied(fix);
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Alert
      variant="warning"
      isInline
      title={t('Windows 11 VMs will not start: VM state storage uses XFS ({{sc}})', { sc: result.className })}
    >
      <p>
        {result.source === 'hyperconverged'
          ? t(
              'OpenShift Virtualization stores each VM\'s TPM and EFI state on {{sc}} (HyperConverged spec.storage.vmStateStorageClass).',
              { sc: result.className },
            )
          : t(
              'OpenShift Virtualization stores each VM\'s TPM and EFI state on the default StorageClass, {{sc}}.',
              { sc: result.className },
            )}{' '}
        {t(
          'That volume is about 10 MiB and XFS cannot be formatted that small, so Windows 11 (and other templates with a persistent TPM or EFI) stay in Scheduling.',
        )}
      </p>
      {fix ? (
        <>
          <p>
            {t('Use {{fix}} for VM state instead. This changes a cluster-wide OpenShift Virtualization setting and needs permission to edit the HyperConverged resource.', { fix })}
          </p>
          <Button variant="secondary" onClick={apply} isLoading={applying} isDisabled={applying}>
            {t('Use {{fix}} for VM state', { fix })}
          </Button>
          <p className="wb-vmstate-cmd">{t('Or as a cluster admin:')}</p>
          <ClipboardCopy isReadOnly hoverTip={t('Copy')} clickTip={t('Copied')}>
            {vmStateStorageCommand(ns, name, fix)}
          </ClipboardCopy>
        </>
      ) : (
        <p>
          {t('No StorageClass with ext4 was found. Ask a cluster admin to set HyperConverged spec.storage.vmStateStorageClass to a class that formats volumes with ext4, or uses block storage.')}
        </p>
      )}
      {applyError ? (
        <Alert variant="danger" isInline isPlain title={t('Could not change the VM state storage class')}>
          {applyError}
        </Alert>
      ) : null}
    </Alert>
  );
};

export default VmStateStorageCheck;
