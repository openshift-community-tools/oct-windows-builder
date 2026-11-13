import {
  DocumentTitle,
  K8sResourceCommon,
  ListPageHeader,
  useK8sModel,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom-v5-compat';
import {
  ActionGroup,
  Alert,
  Breadcrumb,
  BreadcrumbItem,
  Button,
  Checkbox,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  Label,
  PageSection,
  Radio,
  Spinner,
  Stack,
  StackItem,
  TextArea,
  TextInput,
  Title,
} from '@patternfly/react-core';
import { Table, Thead, Tr, Th, Tbody, Td } from '@patternfly/react-table';
import React, { Component, ErrorInfo, FC, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { recommendedAutounattend } from '../utils/autounattend';
import {
  builderHealth,
  BuildRecord,
  cancelBuild,
  clusterVirtioWinImage,
  isActiveBuild,
  listBuilds,
  startBuild,
} from '../utils/builder-api';
import {
  DataVolumeKind,
  DataVolumeModel,
  DataSourceKind,
  DataSourceModel,
  GOLDEN_IMAGE_NAMESPACE,
  PLUGIN_NAMESPACE,
  StorageClassKind,
  StorageClassModel,
  TEMPLATE_NAMESPACE,
  TemplateKind,
  TemplateModel,
  dvStorageClass,
  getK8sErrorMessage,
  isDataSourceReady,
  isDefaultStorageClass,
  isDiscoveredModel,
  isForbiddenError,
  isMissingCrdError,
  isValidDiskName,
  phaseToUi,
  virtioImageFromTemplate,
} from '../utils/k8s-resources';
import {
  CONSUMER_EDITIONS,
  ConsumerEdition,
  DEFAULT_CONSUMER_EDITION_INDEX,
  IsoType,
  defaultDiskSizeForSku,
  editionTitle,
  groupWindowsFamilies,
  installCoresForSku,
  installMemoryForSku,
  isClientSku,
  isoHintForSku,
  preferredTemplateRef,
  templateRefOf,
} from '../utils/windows-skus';
import dashboardLogger from '../utils/logger';
import CommunityDisclaimer from './CommunityDisclaimer';
import EditionTiles from './EditionTiles';
import VmStateStorageCheck from './VmStateStorageCheck';
import './windows-builder.css';

const I18N = 'plugin__oct-windows-builder';
const LOG = 'WINDOWS_BUILDER';
const CUSTOM_SKU = 'custom';

const DV_GVK = {
  group: DataVolumeModel.apiGroup,
  version: DataVolumeModel.apiVersion,
  kind: DataVolumeModel.kind,
};

const TPL_GVK = {
  group: TemplateModel.apiGroup,
  version: TemplateModel.apiVersion,
  kind: TemplateModel.kind,
};

const SC_GVK = {
  group: StorageClassModel.apiGroup,
  version: StorageClassModel.apiVersion,
  kind: StorageClassModel.kind,
};

const DS_GVK = {
  group: DataSourceModel.apiGroup,
  version: DataSourceModel.apiVersion,
  kind: DataSourceModel.kind,
};

type TemplateAction = 'none' | 'existing' | 'custom';
type StepId = 'edition' | 'iso' | 'unattend' | 'template' | 'build';

const STEP_ORDER: StepId[] = ['edition', 'iso', 'unattend', 'template', 'build'];

const statusLabelColor = (status: string): 'green' | 'red' | 'orange' | 'blue' | 'grey' => {
  switch (status) {
    case 'Ready':
    case 'Succeeded':
      return 'green';
    case 'Error':
    case 'Failed':
      return 'red';
    case 'Installing':
    case 'Sysprep':
      return 'blue';
    case 'Pending':
      return 'orange';
    default:
      return 'grey';
  }
};

function isoHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type ErrorBoundaryProps = {
  children: ReactNode;
  fallbackTitle: string;
};

type ErrorBoundaryState = { error: Error | null };

class WindowsBuilderErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    dashboardLogger.error(LOG, 'Windows Builder crashed', `${error.message} ${info.componentStack || ''}`);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <PageSection>
          <Alert variant="danger" isInline title={this.props.fallbackTitle}>
            {this.state.error.message}
          </Alert>
        </PageSection>
      );
    }
    return this.props.children;
  }
}

type WizardSectionProps = {
  n: number;
  title: string;
  summary?: string;
  open: boolean;
  unlocked: boolean;
  done: boolean;
  onOpen: () => void;
  children?: ReactNode;
};

const WizardSection: FC<WizardSectionProps> = ({ n, title, summary, open, unlocked, done, onOpen, children }) => (
  <section className={`wb-step${open ? ' wb-step-open' : ' wb-step-quiet'}${done && !open ? ' wb-step-done' : ''}`}>
    <button type="button" className="wb-step-header" onClick={onOpen} disabled={!unlocked} aria-expanded={open}>
      <span className="wb-step-num">{n}</span>
      <span className="wb-step-title">{title}</span>
      {!open && summary ? <span className="wb-step-summary">{summary}</span> : null}
    </button>
    {open ? <div className="wb-step-body">{children}</div> : null}
  </section>
);

const WindowsBuilderPageInner: FC = () => {
  const { t } = useTranslation(I18N);
  const navigate = useNavigate();

  const [dvModel, modelsInFlight] = useK8sModel(DV_GVK);
  const [dsModel] = useK8sModel(DS_GVK);
  const [tplModel] = useK8sModel(TPL_GVK);
  const [scModel] = useK8sModel(SC_GVK);
  const hasDv = isDiscoveredModel(dvModel);
  const hasDs = isDiscoveredModel(dsModel);
  const hasTpl = isDiscoveredModel(tplModel);
  const hasSc = isDiscoveredModel(scModel);
  const tplMissing = !modelsInFlight && !hasTpl;

  const [dvGolden, dvGoldenLoaded, dvGoldenErr] = useK8sWatchResource<K8sResourceCommon[]>(
    hasDv
      ? {
          groupVersionKind: DV_GVK,
          isList: true,
          namespaced: true,
          namespace: GOLDEN_IMAGE_NAMESPACE,
        }
      : null,
  );

  const [dvWork, dvWorkLoaded, dvWorkErr] = useK8sWatchResource<K8sResourceCommon[]>(
    hasDv
      ? {
          groupVersionKind: DV_GVK,
          isList: true,
          namespaced: true,
          namespace: PLUGIN_NAMESPACE,
        }
      : null,
  );

  const [dataSources] = useK8sWatchResource<K8sResourceCommon[]>(
    hasDs
      ? {
          groupVersionKind: DS_GVK,
          isList: true,
          namespaced: true,
          namespace: GOLDEN_IMAGE_NAMESPACE,
        }
      : null,
  );

  const [templates, templatesLoaded, templatesErr] = useK8sWatchResource<K8sResourceCommon[]>(
    hasTpl
      ? {
          groupVersionKind: TPL_GVK,
          isList: true,
          namespaced: true,
        }
      : null,
  );

  const [storageClasses, scLoaded] = useK8sWatchResource<K8sResourceCommon[]>(
    hasSc
      ? {
          groupVersionKind: SC_GVK,
          isList: true,
          namespaced: false,
        }
      : null,
  );

  const [sku, setSku] = useState('');
  const [customDisk, setCustomDisk] = useState('');
  const [isoURL, setIsoURL] = useState('');
  const [isoTouched, setIsoTouched] = useState(false);
  const [storageClass, setStorageClass] = useState('');
  const [diskSize, setDiskSize] = useState('60Gi');
  const [diskSizeTouched, setDiskSizeTouched] = useState(false);
  const [isoType, setIsoType] = useState<IsoType>('eval');
  const [editionIndex, setEditionIndex] = useState(DEFAULT_CONSUMER_EDITION_INDEX);
  const [xml, setXml] = useState('');
  const [xmlTouched, setXmlTouched] = useState(false);
  const [windowsUpdate, setWindowsUpdate] = useState(true);
  const [templateAction, setTemplateAction] = useState<TemplateAction>('none');
  const [templateRef, setTemplateRef] = useState('');
  const [customTemplate, setCustomTemplate] = useState('');
  const [virtioImage, setVirtioImage] = useState('');
  const [virtioPrefill, setVirtioPrefill] = useState(false);
  const [scPrefill, setScPrefill] = useState(false);
  const [builds, setBuilds] = useState<BuildRecord[]>([]);
  const [cancelConfirm, setCancelConfirm] = useState('');
  const [cancelling, setCancelling] = useState('');
  const [cancelError, setCancelError] = useState('');
  const [builderUp, setBuilderUp] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ variant: 'success' | 'danger'; msg: string } | null>(null);
  const [focus, setFocus] = useState<StepId>('edition');
  const [maxStep, setMaxStep] = useState<StepId>('edition');
  const [disksOpen, setDisksOpen] = useState(false);

  const families = useMemo(
    () => groupWindowsFamilies((templates || []) as TemplateKind[]),
    [templates],
  );

  const selectedFamily = sku && sku !== CUSTOM_SKU ? families.find((f) => f.id === sku) : undefined;
  const autounattendSku = sku === CUSTOM_SKU ? customDisk.trim() || CUSTOM_SKU : sku || CUSTOM_SKU;
  const diskName = sku === CUSTOM_SKU ? customDisk.trim() : sku;
  const isoHint = isoHintForSku(sku === CUSTOM_SKU ? CUSTOM_SKU : sku);
  const isClient = isClientSku(sku) && sku !== CUSTOM_SKU;
  const showEditionPicker = isClient && isoType === 'consumer';
  const familyTemplates = selectedFamily?.templates || [];
  const editionSummary = sku === CUSTOM_SKU
    ? customDisk.trim() || t('Custom')
    : selectedFamily
      ? editionTitle(selectedFamily.id, selectedFamily.displayName)
      : '';

  const editionReady = sku === CUSTOM_SKU ? isValidDiskName(customDisk.trim()) : Boolean(sku);
  const isoReady = /^https?:\/\//i.test(isoURL.trim());
  const xmlReady = xml.trim().length > 0;

  const unlock: Record<StepId, boolean> = {
    edition: true,
    iso: editionReady,
    unattend: editionReady && isoReady,
    template: editionReady && isoReady && xmlReady,
    build: editionReady && isoReady && xmlReady,
  };

  const openStep = (id: StepId) => {
    if (!unlock[id]) return;
    setFocus(id);
  };

  const goNext = (id: StepId) => {
    const i = STEP_ORDER.indexOf(id);
    const next = STEP_ORDER[Math.min(i + 1, STEP_ORDER.length - 1)];
    setMaxStep((cur) => (STEP_ORDER.indexOf(next) > STEP_ORDER.indexOf(cur) ? next : cur));
    setFocus(next);
  };

  const goldenDVs = useMemo(() => {
    const fromGolden = ((dvGolden || []) as DataVolumeKind[]).filter((d) => d?.metadata?.name);
    const fromWork = ((dvWork || []) as DataVolumeKind[]).filter((d) => d?.metadata?.name);
    const map = new Map<string, DataVolumeKind>();
    fromWork.forEach((d) => map.set(`${d.metadata.namespace}/${d.metadata.name}`, d));
    fromGolden.forEach((d) => map.set(`${d.metadata.namespace}/${d.metadata.name}`, d));
    const ids = new Set(families.map((f) => f.id));
    const list = Array.from(map.values());
    list.sort((a, b) => {
      const ap = ids.has(a.metadata.name) ? 0 : 1;
      const bp = ids.has(b.metadata.name) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.metadata.name.localeCompare(b.metadata.name);
    });
    return list;
  }, [dvGolden, dvWork, families]);

  const scList = useMemo(
    () => ((storageClasses || []) as StorageClassKind[]).filter((s) => s?.metadata?.name),
    [storageClasses],
  );

  const builtDisks = useMemo(() => {
    const names = new Set<string>();
    ((dvGolden || []) as DataVolumeKind[]).forEach((d) => {
      if (d?.metadata?.name && d.status?.phase === 'Succeeded') {
        names.add(d.metadata.name);
      }
    });
    ((dataSources || []) as DataSourceKind[]).forEach((ds) => {
      if (ds?.metadata?.name && isDataSourceReady(ds)) {
        names.add(ds.metadata.name);
      }
    });
    return names;
  }, [dvGolden, dataSources]);

  useEffect(() => {
    if (xmlTouched || !sku) return;
    setXml(recommendedAutounattend(autounattendSku, isoType, isoType === 'consumer' ? editionIndex : undefined, windowsUpdate));
  }, [sku, customDisk, xmlTouched, autounattendSku, isoType, editionIndex, windowsUpdate]);

  useEffect(() => {
    if (isoTouched || !sku) return;
    setIsoURL(isoHint.url || '');
  }, [sku, isoTouched, isoHint.url]);

  useEffect(() => {
    if (diskSizeTouched || !sku) return;
    setDiskSize(defaultDiskSizeForSku(sku, selectedFamily));
  }, [sku, selectedFamily, diskSizeTouched]);

  useEffect(() => {
    if (virtioPrefill) return;
    const all = families.flatMap((f) => f.templates);
    for (const tpl of all) {
      const img = virtioImageFromTemplate(tpl);
      if (img) {
        setVirtioImage(img);
        setVirtioPrefill(true);
        return;
      }
    }
    void clusterVirtioWinImage().then((img) => {
      if (img) setVirtioImage(img);
      setVirtioPrefill(true);
    });
  }, [families, virtioPrefill]);

  useEffect(() => {
    if (scPrefill || !scLoaded) return;
    const fromDv = goldenDVs.map(dvStorageClass).find(Boolean);
    if (fromDv) {
      setStorageClass(fromDv);
      setScPrefill(true);
      return;
    }
    setScPrefill(true);
  }, [goldenDVs, scLoaded, scPrefill]);

  useEffect(() => {
    if (templateAction !== 'existing') return;
    if (!familyTemplates.length) {
      setTemplateRef('');
      return;
    }
    const still = familyTemplates.some((tpl) => templateRefOf(tpl) === templateRef);
    if (!still) setTemplateRef(preferredTemplateRef(familyTemplates));
  }, [templateAction, familyTemplates, templateRef]);

  useEffect(() => {
    if (tplMissing && templateAction === 'existing') setTemplateAction('none');
  }, [tplMissing, templateAction]);

  const refreshBuilds = useCallback(async () => {
    try {
      const up = await builderHealth();
      setBuilderUp(up);
      if (!up) return;
      const next = await listBuilds();
      setBuilds(next);
    } catch (err) {
      setBuilderUp(false);
      dashboardLogger.warn(LOG, 'Builder poll failed', getK8sErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refreshBuilds();
    const id = window.setInterval(() => void refreshBuilds(), 8000);
    return () => window.clearInterval(id);
  }, [refreshBuilds]);

  useEffect(() => {
    const busy = builds.some((b) => isActiveBuild(b.status));
    if (busy) setDisksOpen(true);
  }, [builds]);

  const onCancelBuild = async (diskName: string) => {
    setCancelling(diskName);
    setCancelError('');
    try {
      await cancelBuild(diskName);
      setCancelConfirm('');
      await refreshBuilds();
    } catch (err) {
      setCancelError(getK8sErrorMessage(err));
    } finally {
      setCancelling('');
    }
  };

  const sortedBuilds = useMemo(
    () => [...builds].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')),
    [builds],
  );

  const onSku = (next: string) => {
    setSku(next);
    setXmlTouched(false);
    setIsoTouched(false);
    setDiskSizeTouched(false);
    setIsoType('eval');
    setEditionIndex(DEFAULT_CONSUMER_EDITION_INDEX);
    setStatus(null);
    setMaxStep((cur) => (STEP_ORDER.indexOf('iso') > STEP_ORDER.indexOf(cur) ? 'iso' : cur));
    if (next !== CUSTOM_SKU) setFocus('iso');
  };

  const submit = useCallback(async () => {
    if (!isoURL.trim()) {
      setStatus({ variant: 'danger', msg: t('ISO URL is required.') });
      setFocus('iso');
      return;
    }
    if (!isValidDiskName(diskName)) {
      setStatus({ variant: 'danger', msg: t('Enter a valid DataVolume name.') });
      setFocus('edition');
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      let templateName = '';
      let templateNamespace = selectedFamily?.templates[0]?.metadata.namespace || TEMPLATE_NAMESPACE;
      let customTpl = false;
      if (templateAction === 'existing' && templateRef) {
        const slash = templateRef.indexOf('/');
        templateNamespace = templateRef.slice(0, slash);
        templateName = templateRef.slice(slash + 1);
      } else if (templateAction === 'custom') {
        templateName = customTemplate.trim();
        customTpl = true;
      }
      const rec = await startBuild({
        diskName,
        isoURL: isoURL.trim(),
        autounattend: xml,
        storageClassName: storageClass || undefined,
        diskSize,
        isoSize: '12Gi',
        goldenNamespace: selectedFamily?.goldenNamespace || GOLDEN_IMAGE_NAMESPACE,
        customTemplate: customTpl,
        templateName: templateName || undefined,
        templateNamespace,
        virtioImage: virtioImage.trim() || undefined,
        memory: installMemoryForSku(sku === CUSTOM_SKU ? diskName : sku),
        cores: installCoresForSku(sku === CUSTOM_SKU ? diskName : sku),
      });
      dashboardLogger.info(LOG, 'Started build', rec.diskName);
      setStatus({ variant: 'success', msg: t('Build started.') });
      setDisksOpen(true);
      await refreshBuilds();
    } catch (err) {
      dashboardLogger.error(LOG, 'Start build failed', getK8sErrorMessage(err));
      setStatus({ variant: 'danger', msg: `${t('Could not start the build.')} ${getK8sErrorMessage(err)}` });
    } finally {
      setSaving(false);
    }
  }, [
    isoURL,
    diskName,
    xml,
    storageClass,
    diskSize,
    templateAction,
    templateRef,
    customTemplate,
    virtioImage,
    selectedFamily,
    sku,
    t,
    refreshBuilds,
  ]);

  const dvErr = dvGoldenErr || dvWorkErr;
  const dvForbidden = isForbiddenError(dvErr);
  const dvMissingCrd = isMissingCrdError(dvErr);
  const cdiMissing = (!modelsInFlight && !hasDv) || dvMissingCrd;
  const tplForbidden = isForbiddenError(templatesErr);
  const existing = goldenDVs.some(
    (d) => d.metadata.name === diskName && d.metadata.namespace === (selectedFamily?.goldenNamespace || GOLDEN_IMAGE_NAMESPACE),
  );
  const buildByDisk = useMemo(() => {
    const m = new Map<string, BuildRecord>();
    builds.forEach((b) => m.set(b.diskName, b));
    return m;
  }, [builds]);

  const dvLoading = modelsInFlight || (hasDv && !dvGoldenLoaded && !dvWorkLoaded && !dvErr);
  const canStart = !saving && !cdiMissing && isoReady && isValidDiskName(diskName);
  const tplLoading = hasTpl && !templatesLoaded && !templatesErr;
  const templateSummary =
    templateAction === 'none'
      ? t('DataVolume only')
      : templateAction === 'existing'
        ? templateRef || t('Update an existing template')
        : customTemplate.trim() || t('Create a custom template');

  const goComputeHub = () => {
    navigate('/community-tools/compute');
  };

  const reached = (id: StepId) => STEP_ORDER.indexOf(maxStep) >= STEP_ORDER.indexOf(id) && unlock[id];

  return (
    <>
      <DocumentTitle>{t('Windows Builder')}</DocumentTitle>
      <PageSection type="breadcrumb">
        <Breadcrumb>
          <BreadcrumbItem
            component="a"
            onClick={(e) => {
              e.preventDefault();
              goComputeHub();
            }}
          >
            {t('Compute')}
          </BreadcrumbItem>
          <BreadcrumbItem isActive>{t('Windows Builder')}</BreadcrumbItem>
        </Breadcrumb>
      </PageSection>
      <ListPageHeader title={t('Windows Builder')} />
      <PageSection>
        <Stack hasGutter>
          <StackItem>
            <CommunityDisclaimer />
          </StackItem>
          {cdiMissing ? (
            <StackItem>
              <Alert variant="danger" isInline title={t('CDI or KubeVirt is not installed (DataVolume API missing). OpenShift Virtualization is required.')} />
            </StackItem>
          ) : null}
          {tplMissing ? (
            <StackItem>
              <Alert variant="warning" isInline title={t('Templates API is not available. You can still enter a custom template name.')} />
            </StackItem>
          ) : null}
          {dvErr && !dvMissingCrd ? (
            <StackItem>
              <Alert
                variant="danger"
                isInline
                title={dvForbidden || tplForbidden ? t('You do not have permission to list DataVolumes or Templates.') : t('Could not load DataVolumes.')}
              >
                {getK8sErrorMessage(dvErr)}
              </Alert>
            </StackItem>
          ) : null}
          {templatesErr && !isMissingCrdError(templatesErr) && !tplMissing ? (
            <StackItem>
              <Alert variant="warning" isInline title={t('Could not load Templates.')}>
                {getK8sErrorMessage(templatesErr)}
              </Alert>
            </StackItem>
          ) : null}
          {builderUp === false ? (
            <StackItem>
              <Alert variant="warning" isInline title={t('Builder is not reachable. The windows-builder service must be running in oct-windows-builder.')} />
            </StackItem>
          ) : null}

          {hasSc ? (
            <StackItem>
              <VmStateStorageCheck storageClasses={scList} storageClassesLoaded={Boolean(scLoaded)} />
            </StackItem>
          ) : null}

          <StackItem>
            <Form
              className="wb-wizard"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <WizardSection
                n={1}
                title={t('Edition')}
                summary={editionSummary}
                open={focus === 'edition'}
                unlocked
                done={editionReady}
                onOpen={() => openStep('edition')}
              >
                <p className="wb-lead">{t('Choose a Windows edition. We will ask for an ISO next.')}</p>
                <EditionTiles families={families} sku={sku} loading={tplLoading} built={builtDisks} onSelect={onSku} />
                {sku === CUSTOM_SKU ? (
                  <FormGroup label={t('DataVolume name')} fieldId="wb-disk" isRequired>
                    <TextInput
                      id="wb-disk"
                      value={customDisk}
                      onChange={(_e, v) => setCustomDisk(v)}
                      validated={customDisk && !isValidDiskName(customDisk.trim()) ? 'error' : 'default'}
                      aria-label={t('DataVolume name')}
                    />
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>{t('Must be a DNS-1123 name (lowercase, digits, dashes), max 50 characters.')}</HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>
                ) : null}
                {selectedFamily ? (
                  <FormHelperText>
                    <HelperText>
                      <HelperTextItem>
                        {t('Golden DataVolume name comes from the template DATA_SOURCE_NAME parameter ({{name}}).', {
                          name: selectedFamily.id,
                        })}
                      </HelperTextItem>
                    </HelperText>
                  </FormHelperText>
                ) : null}
                {sku === CUSTOM_SKU && isValidDiskName(customDisk.trim()) ? (
                  <div className="wb-continue">
                    <Button variant="primary" onClick={() => goNext('edition')}>
                      {t('Continue')}
                    </Button>
                  </div>
                ) : null}
              </WizardSection>

              <WizardSection
                n={2}
                title={t('ISO')}
                summary={isoReady
                  ? showEditionPicker
                    ? `${CONSUMER_EDITIONS.find((e) => e.index === editionIndex)?.label || 'Pro'} \u2014 ${isoHost(isoURL)}`
                    : isoHost(isoURL)
                  : undefined}
                open={focus === 'iso'}
                unlocked={unlock.iso}
                done={isoReady}
                onOpen={() => openStep('iso')}
              >
                {isClient ? (
                  <FormGroup label={t('ISO type')} fieldId="wb-iso-type">
                    <Radio
                      id="wb-iso-type-eval"
                      name="wb-iso-type"
                      label={t('Enterprise Evaluation')}
                      description={t('Free evaluation ISO from Microsoft. No product key required.')}
                      isChecked={isoType === 'eval'}
                      onChange={() => {
                        setIsoType('eval');
                        setXmlTouched(false);
                      }}
                    />
                    <Radio
                      id="wb-iso-type-consumer"
                      name="wb-iso-type"
                      label={t('Consumer / Retail')}
                      description={t('Multi-edition ISO from microsoft.com. Select an edition below.')}
                      isChecked={isoType === 'consumer'}
                      onChange={() => {
                        setIsoType('consumer');
                        setXmlTouched(false);
                      }}
                    />
                  </FormGroup>
                ) : null}
                {showEditionPicker ? (
                  <FormGroup label={t('Windows edition')} fieldId="wb-edition">
                    <FormSelect
                      id="wb-edition"
                      value={String(editionIndex)}
                      onChange={(_e, v) => {
                        setEditionIndex(Number(v));
                        setXmlTouched(false);
                      }}
                      aria-label={t('Windows edition')}
                    >
                      {CONSUMER_EDITIONS.map((ed: ConsumerEdition) => (
                        <FormSelectOption
                          key={ed.index}
                          value={String(ed.index)}
                          label={ed.label}
                        />
                      ))}
                    </FormSelect>
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          {t('Standard consumer ISO edition. Pro is recommended for general use.')}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>
                ) : null}
                <FormGroup label={t('Windows ISO URL')} fieldId="wb-iso" isRequired>
                  <TextInput
                    id="wb-iso"
                    value={isoURL}
                    onChange={(_e, v) => {
                      setIsoURL(v);
                      setIsoTouched(true);
                    }}
                    placeholder="https://"
                    aria-label={t('Windows ISO URL')}
                  />
                  {isoHint.url ? (
                    <div className="wb-iso-actions">
                      <Button
                        variant="link"
                        isInline
                        onClick={() => {
                          setIsoURL(isoHint.url || '');
                          setIsoTouched(false);
                          goNext('iso');
                        }}
                      >
                        {t('Use suggested ISO URL')}
                      </Button>
                    </div>
                  ) : null}
                  <FormHelperText>
                    <HelperText>
                      <HelperTextItem>
                        {showEditionPicker
                          ? t('Paste the consumer ISO URL. The cluster must be able to pull this URL over HTTPS.')
                          : t(isoHint.helper)}
                      </HelperTextItem>
                      {showEditionPicker ? (
                        <HelperTextItem>
                          <a
                            href={sku === 'win10'
                              ? 'https://www.microsoft.com/software-download/windows10ISO'
                              : 'https://www.microsoft.com/software-download/windows11'}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t('Microsoft Software Download')}
                          </a>
                        </HelperTextItem>
                      ) : isoHint.evalCenter ? (
                        <HelperTextItem>
                          <a href={isoHint.evalCenter} target="_blank" rel="noreferrer">
                            {t('Microsoft Evaluation Center')}
                          </a>
                        </HelperTextItem>
                      ) : null}
                    </HelperText>
                  </FormHelperText>
                </FormGroup>
                {isoReady ? (
                  <div className="wb-continue">
                    <Button variant="primary" onClick={() => goNext('iso')}>
                      {t('Continue')}
                    </Button>
                  </div>
                ) : null}
              </WizardSection>

              <WizardSection
                n={3}
                title={t('Autounattend')}
                summary={xmlReady ? t('Recommended for this version') : undefined}
                open={focus === 'unattend'}
                unlocked={unlock.unattend}
                done={xmlReady && reached('unattend')}
                onOpen={() => openStep('unattend')}
              >
                <Checkbox
                  id="wb-windows-update"
                  isChecked={windowsUpdate}
                  isDisabled={xmlTouched}
                  onChange={(_e, v) => setWindowsUpdate(v)}
                  label={t('Install Windows updates before sealing (recommended)')}
                  description={
                    xmlTouched
                      ? t('The XML was edited by hand. Use the recommended XML to change this option.')
                      : t('Runs Windows Update in the install VM until no updates remain, then sysprep. The build takes longer (often 30–90 minutes more), but VMs from the image start without a long first-boot update. Needs internet access from the install VM.')
                  }
                />
                <FormGroup label={t('Autounattend.xml')} fieldId="wb-xml">
                  <Button
                    variant="link"
                    isInline
                    onClick={() => {
                      setXml(recommendedAutounattend(autounattendSku, isoType, isoType === 'consumer' ? editionIndex : undefined, windowsUpdate));
                      setXmlTouched(false);
                    }}
                  >
                    {t('Use recommended for this version')}
                  </Button>
                  <TextArea
                    className="wb-xml"
                    id="wb-xml"
                    value={xml}
                    onChange={(_e, v) => {
                      setXml(v);
                      setXmlTouched(true);
                    }}
                    rows={10}
                    aria-label={t('Autounattend.xml')}
                  />
                  <FormHelperText>
                    <HelperText>
                      <HelperTextItem>
                        {t('Virtio drivers (viostor, NetKVM, Balloon) and qemu-guest-agent from the cluster virtio-win CD (letters D–G), GPT/EFI, no ProductKey on Evaluation Center media, then sysprep /generalize /oobe /shutdown. Windows 11 also bypasses TPM/Secure Boot checks. Edit the temporary AutoLogon password. No Cloudbase-Init.')}
                      </HelperTextItem>
                    </HelperText>
                  </FormHelperText>
                </FormGroup>
                {xmlReady ? (
                  <div className="wb-continue">
                    <Button variant="primary" onClick={() => goNext('unattend')}>
                      {t('Continue')}
                    </Button>
                  </div>
                ) : null}
              </WizardSection>

              <WizardSection
                n={4}
                title={t('Template')}
                summary={reached('template') ? templateSummary : undefined}
                open={focus === 'template'}
                unlocked={unlock.template}
                done={reached('template')}
                onOpen={() => openStep('template')}
              >
                <FormGroup label={t('Template')} fieldId="wb-tpl-mode">
                  <Radio
                    id="wb-tpl-none"
                    name="wb-tpl-mode"
                    label={t("Don't update templates (DataVolume only)")}
                    isChecked={templateAction === 'none'}
                    onChange={() => setTemplateAction('none')}
                  />
                  <Radio
                    id="wb-tpl-existing"
                    name="wb-tpl-mode"
                    label={t('Update an existing template')}
                    isChecked={templateAction === 'existing'}
                    onChange={() => setTemplateAction('existing')}
                    isDisabled={tplMissing || (sku !== CUSTOM_SKU && familyTemplates.length === 0)}
                  />
                  <Radio
                    id="wb-tpl-custom"
                    name="wb-tpl-mode"
                    label={t('Create a custom template')}
                    isChecked={templateAction === 'custom'}
                    onChange={() => setTemplateAction('custom')}
                  />
                </FormGroup>
                {templateAction === 'existing' && !tplMissing ? (
                  <FormGroup label={t('Template to update')} fieldId="wb-tpl">
                    <FormSelect
                      id="wb-tpl"
                      value={templateRef}
                      onChange={(_e, v) => setTemplateRef(v)}
                      aria-label={t('Template to update')}
                      isDisabled={familyTemplates.length === 0 || !templatesLoaded}
                    >
                      {familyTemplates.length === 0 ? (
                        <FormSelectOption value="" label={t('No Windows Templates found for this family.')} />
                      ) : (
                        familyTemplates.map((tpl) => {
                          const val = templateRefOf(tpl);
                          return <FormSelectOption key={val} value={val} label={val} />;
                        })
                      )}
                    </FormSelect>
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          {t('Stock templates already clone this DataSource name. Updating sets DATA_SOURCE_NAME to this DataVolume.')}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>
                ) : null}
                {templateAction === 'custom' ? (
                  <FormGroup label={t('Custom template name')} fieldId="wb-tpl-name">
                    <TextInput
                      id="wb-tpl-name"
                      value={customTemplate}
                      onChange={(_e, v) => setCustomTemplate(v)}
                      aria-label={t('Custom template name')}
                    />
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>{t('Created in the openshift namespace unless you select an existing Template.')}</HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>
                ) : null}
                <div className="wb-continue">
                  <Button variant="primary" onClick={() => goNext('template')}>
                    {t('Continue')}
                  </Button>
                </div>
              </WizardSection>

              <WizardSection
                n={5}
                title={t('Build')}
                summary={undefined}
                open={focus === 'build'}
                unlocked={unlock.build && reached('build')}
                done={false}
                onOpen={() => openStep('build')}
              >
                <FormGroup label={t('Storage class')} fieldId="wb-sc">
                  <FormSelect
                    id="wb-sc"
                    value={storageClass}
                    onChange={(_e, v) => setStorageClass(v)}
                    aria-label={t('Storage class')}
                  >
                    <FormSelectOption value="" label={t('Cluster default')} />
                    {scList.map((sc) => (
                      <FormSelectOption
                        key={sc.metadata.name}
                        value={sc.metadata.name}
                        label={isDefaultStorageClass(sc) ? `${sc.metadata.name} (${t('default')})` : sc.metadata.name}
                      />
                    ))}
                  </FormSelect>
                  <FormHelperText>
                    <HelperText>
                      <HelperTextItem>{t('Omit to use the cluster default. Never hardcode a lab class.')}</HelperTextItem>
                    </HelperText>
                  </FormHelperText>
                </FormGroup>
                <FormGroup label={t('Disk size')} fieldId="wb-size">
                  <TextInput
                    id="wb-size"
                    value={diskSize}
                    onChange={(_e, v) => {
                      setDiskSize(v);
                      setDiskSizeTouched(true);
                    }}
                    aria-label={t('Disk size')}
                  />
                </FormGroup>
                <FormGroup label={t('virtio-win containerDisk')} fieldId="wb-virtio">
                  <TextInput
                    id="wb-virtio"
                    value={virtioImage}
                    onChange={(_e, v) => setVirtioImage(v)}
                    aria-label={t('virtio-win containerDisk')}
                  />
                  <FormHelperText>
                    <HelperText>
                      <HelperTextItem>
                        {t('Optional. Leave empty to use the cluster virtio-win containerDisk (OpenShift Virtualization ConfigMap virtio-win). Do not paste an ISO URL.')}
                      </HelperTextItem>
                    </HelperText>
                  </FormHelperText>
                </FormGroup>
                {existing ? (
                  <Alert
                    variant="warning"
                    isInline
                    title={t('This replaces DataVolume {{name}} if it already exists, after the new install disk is ready.', { name: diskName })}
                  />
                ) : null}
                {status ? <Alert variant={status.variant} isInline title={status.msg} /> : null}
                <ActionGroup className="wb-actions">
                  <Button variant="primary" type="submit" isDisabled={!canStart} isLoading={saving}>
                    {t('Start build')}
                  </Button>
                </ActionGroup>
              </WizardSection>
            </Form>
          </StackItem>

          {sortedBuilds.length > 0 ? (
            <StackItem>
              <Title headingLevel="h2" size="md">{t('Builds')}</Title>
              {cancelError ? <Alert variant="danger" isInline title={t('Could not cancel the build')}>{cancelError}</Alert> : null}
              <Table variant="compact" aria-label={t('Builds')}>
                <Thead>
                  <Tr>
                    <Th>{t('Disk')}</Th>
                    <Th>{t('Status')}</Th>
                    <Th>{t('Progress')}</Th>
                    <Th>{t('Started')}</Th>
                    <Th screenReaderText={t('Actions')} />
                  </Tr>
                </Thead>
                <Tbody>
                  {sortedBuilds.map((b) => (
                    <Tr key={b.diskName}>
                      <Td dataLabel={t('Disk')}>{b.diskName}</Td>
                      <Td dataLabel={t('Status')}>
                        <Label color={statusLabelColor(b.status)}>{t(b.status)}</Label>
                      </Td>
                      <Td dataLabel={t('Progress')}>{b.message || '—'}</Td>
                      <Td dataLabel={t('Started')}>{b.startedAt ? new Date(b.startedAt).toLocaleString() : '—'}</Td>
                      <Td dataLabel={t('Actions')} isActionCell>
                        {isActiveBuild(b.status) ? (
                          cancelConfirm === b.diskName ? (
                            <span className="wb-cancel-confirm">
                              {t('Cancel this build? The install VM and unfinished disks are deleted.')}{' '}
                              <Button
                                variant="danger"
                                size="sm"
                                onClick={() => void onCancelBuild(b.diskName)}
                                isLoading={cancelling === b.diskName}
                                isDisabled={cancelling === b.diskName}
                              >
                                {t('Cancel build')}
                              </Button>{' '}
                              <Button variant="link" size="sm" onClick={() => setCancelConfirm('')} isDisabled={cancelling === b.diskName}>
                                {t('Keep running')}
                              </Button>
                            </span>
                          ) : (
                            <Button variant="secondary" size="sm" onClick={() => setCancelConfirm(b.diskName)}>
                              {t('Cancel')}
                            </Button>
                          )
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </StackItem>
          ) : null}

          <StackItem>
            <div className="wb-disks">
              <button type="button" className="wb-disks-toggle" onClick={() => setDisksOpen((v) => !v)} aria-expanded={disksOpen}>
                {disksOpen ? t('Hide golden disks') : t('Golden disks')}
                {goldenDVs.length ? ` (${goldenDVs.length})` : ''}
              </button>
              {disksOpen ? (
                dvLoading ? (
                  <Spinner size="md" aria-label={t('Loading')} />
                ) : cdiMissing ? (
                  <p className="wb-lead">{t('No DataVolumes to show until OpenShift Virtualization (CDI) is installed.')}</p>
                ) : goldenDVs.length === 0 ? (
                  <p className="wb-lead">{t('No Windows DataVolumes yet.')}</p>
                ) : (
                  <Table variant="compact" aria-label={t('Golden disks')}>
                    <Thead>
                      <Tr>
                        <Th>{t('Name')}</Th>
                        <Th>{t('Phase')}</Th>
                        <Th>{t('Build')}</Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {goldenDVs.map((dv) => {
                        const b = buildByDisk.get(dv.metadata.name);
                        const ui = b?.status || phaseToUi(dv.status?.phase);
                        return (
                          <Tr key={`${dv.metadata.namespace}/${dv.metadata.name}`}>
                            <Td dataLabel={t('Name')}>{dv.metadata.name}</Td>
                            <Td dataLabel={t('Phase')}>
                              <Label color={statusLabelColor(ui)}>{dv.status?.phase || ui}</Label>
                            </Td>
                            <Td dataLabel={t('Build')}>
                              {b ? (
                                <span className="wb-status-row">
                                  <Label color={statusLabelColor(b.status)}>{t(b.status)}</Label>
                                  {b.message ? <span>{b.message}</span> : null}
                                </span>
                              ) : (
                                '—'
                              )}
                            </Td>
                          </Tr>
                        );
                      })}
                    </Tbody>
                  </Table>
                )
              ) : null}
            </div>
          </StackItem>
        </Stack>
      </PageSection>
    </>
  );
};

const WindowsBuilderPage: FC = () => {
  const { t } = useTranslation(I18N);
  return (
    <WindowsBuilderErrorBoundary fallbackTitle={t('Windows Builder could not load.')}>
      <WindowsBuilderPageInner />
    </WindowsBuilderErrorBoundary>
  );
};

export default WindowsBuilderPage;
