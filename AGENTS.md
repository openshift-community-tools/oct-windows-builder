# AGENTS.md — Windows Builder (OCT extension)

This is **OpenShift Community Tools (OCT)**, a **community project**, not an official Red Hat supported product. Do not describe it as official Red Hat software.

This repository is the **Windows Builder** ConsolePlugin. It is **not** the OCT storefront. Catalog hubs live in `oct-storefront`.

## Identifiers

| | Value |
| --- | --- |
| Plugin ID / ConsolePlugin / `package.json` `consolePlugin.name` | **`oct-windows-builder`** |
| Image | `quay.io/<org>/oct-windows-builder:1.0.19-ocp4.22` (and `:1.0.19-ocp4.21`; `<semver>-ocp<major.minor>`) |
| Builder image | `quay.io/<org>/oct-windows-builder-builder:1.0.19-ocp4.22` (and `:1.0.19-ocp4.21`) |
| i18n | `plugin__oct-windows-builder` |
| Route | `/community-tools/compute/windows-builder` |
| Proxy | `/api/proxy/plugin/oct-windows-builder/windows-builder` |
| CSS prefix | `wb-` |

Display name is **Windows Builder**. Hub is **Compute** (`category: compute`).

**Current version:** `1.0.19` (package.json / consolePlugin.version).

## Supported Windows editions

| `DATA_SOURCE_NAME` | Display name | ISO type |
| --- | --- | --- |
| `win2k25` | Windows Server 2025 | eval only |
| `win2k22` | Windows Server 2022 | eval only |
| `win2k19` | Windows Server 2019 | eval only |
| `win2k16` | Windows Server 2016 | eval only |
| `win11` | Windows 11 | eval or consumer |
| `win10` | Windows 10 | eval or consumer |

- **Consumer editions** (win10/win11 only): `IsoType = 'eval' | 'consumer'`. Consumer uses WIM indexes from `CONSUMER_EDITIONS` (Pro=6, Home=1, Education=4, Pro for Workstations=10, Pro Education=8). Server SKUs are eval-only.
- Custom DNS-1123 name also supported.

## What this plugin owns

- List CDI DataVolumes used as Windows golden images (template `DATA_SOURCE_NAME` such as `win2k19`, plus custom names)
- Start a long-running unattended Windows install (ISO URL + Autounattend + sysprep) via the in-cluster **builder**
- Optionally update an OpenShift Template `DATA_SOURCE_NAME` or create a custom Template

**No Tekton. No Argo CD.** Kubernetes Jobs are not required; the builder Deployment drives DataVolumes, a one-shot KubeVirt VM, then a clone DV.

## Architecture

| Piece | Role |
| --- | --- |
| Console plugin (`src/`) | Form + status. Kubernetes reads via Console SDK (user token). |
| Plugin nginx (`Containerfile`, `deploy/`) | Serves webpack `dist/`. ConsolePlugin **oct-windows-builder**. |
| Builder (`builder/`) | In-cluster Go service. Uses its ServiceAccount for DVs, VMs, PVCs, ConfigMaps, Templates, DataSources. |

Typical flow (see `docs/install-job.md`):

1. DataVolume for the Windows ISO (`source.http.url` the user supplied).
2. Blank DataVolume for the install disk.
3. ConfigMap `autounattend.xml` / `Autounattend.xml` (ConfigMap **CD-ROM**, GitOps win2k19 layout). Do not publish `unattend.xml` with the install XML.
4. VM boots ISO + cluster virtio-win containerDisk + Autounattend.
5. Unattended setup → FirstLogonCommands run **sysprep /generalize /oobe /shutdown /quiet /mode:vm**.
6. Guest ACPI shutdown **after qemu-guest-agent connected** (FirstLogon installed tools, then sysprep). That is **Ready**. A ~7 minute ACPI with no guest agent is **Error** (unsealed). Clone the disk to DataVolume `win2k19` (etc.) in `openshift-virtualization-os-images`.
7. Optional Template create/update; DataSource pointing at that PVC.

### Autounattend.xml generation

`recommendedAutounattend(skuId, isoType, editionIndex?)` builds a full unattend from `profileForSku`: GPT/EFI partitions, `/IMAGE/INDEX`, optional WinPE virtio drivers, Win11 LabConfig/BypassNRO, specialize drivers, and FirstLogon (virtio-gt + qemu-ga + sysprep). No ProductKey on recommended eval XML. Consumer ISOs use the selected edition's WIM index instead of the profile default.

### virtio-win driver installation

- **VM:** virtio-win as a SATA `containerDisk` CD. Image from build request or cluster ConfigMap `virtio-win` (`clusterVirtioWinImage`).
- **WinPE:** `DriverPaths` for viostor/NetKVM/Balloon under D–G × SKU folders (`w10`, `w11`, `2k19`, …); skipped for win11/win2k25 (known 0x80070103).
- **FirstLogon:** installs `virtio-win-gt-x64.msi` + `qemu-ga-x86_64.msi` on letters D–G.

### AppX cleanup (client editions)

For **all client** profiles (win10/win11, regardless of `isoType`), FirstLogon runs `Get-AppxPackage -AllUsers | Remove-AppxPackage` and `Get-AppxProvisionedPackage -Online | Remove-AppxProvisionedPackage`, then sets `SkipAppxValidation` registry key so sysprep does not fail on leftover Store apps (e.g. Cortana).

### Install disk and VirtIO boot

- The install disk (`wb-install-<disk>`) is **recreated on every build**. A disk left by an earlier build holds that build's sealed Windows and, as bootOrder 1, would boot instead of Setup.
- Windows is installed onto **SATA**. When WinPE loads viostor (`PnpCustomizationsWinPE`), Setup carries it into the image as a boot driver. Win11 / Server 2025 skip WinPE drivers, so the builder attaches a 1Gi VirtIO `emptyDisk` (`virtio-storage-probe`, last disk, not bootable) when the answer file's WinPE pass has no viostor: virtio-win-gt at FirstLogon then binds viostor to a real VirtIO disk and it stays a boot driver through sysprep, so the golden image boots from SATA **or** VirtIO. The probe is never added when WinPE loads viostor (Setup would see a second disk; `DiskID 0` must stay the SATA install disk).

### Windows updates before sealing (wizard option, default on)

With the option on, FirstLogon runs `wb-update.ps1` (embedded in the builder, published on the answer-file CD). It installs software updates through the Windows Update API, reboots only when Windows requires it (startup task `oct-windows-builder-update`, at most 8 passes), cleans up the component store, then runs sysprep. If Windows is still up 3 minutes after `sysprep.exe` exits, it logs `setuperr.log`, reboots once and retries; a second failure is reported as `wb-update: ERROR: ...` and the builder fails the build (never clones an unsealed disk). The startup task is deleted before every sysprep run so it is never sealed into the golden image. Progress lines (`wb-update: ...`) go to COM1; the builder reads the install VM's `guest-console-log` sidecar (an **init container**) and shows the latest line as the build status. The builder resumes a build whose install VM is still running after a builder restart (e.g. a Windows Builder update).

### Cancel

`POST /api/v1/builds/{disk}/cancel` (wizard: Builds list, Cancel with confirmation) stops a running build at its next check, deletes the install VM and install disk, and deletes the ISO import unless it finished (kept for the next build). Status `Cancelled` is final: later updates from the build's goroutine are ignored. Refused (409) while the golden disk is being cloned, because the previous golden disk is already replaced then.

### VMI watcher and `sawRunning` guard

`waitVMI` polls the VMI for up to 4h. `vmiWaitState.sawRunning` must become `true` before treating `Succeeded`/NotFound/Stopped as a real exit (avoids stale-VMI races). Stale resources are ignored via `vmCreatedAfter`. `evaluateGuestExit` requires qemu-ga connection when virtio is used — no agent = unsealed = Error.

### Golden DV cloning and DataSource

After sysprep shutdown, the builder clones the install disk to a DataVolume in `openshift-virtualization-os-images` (e.g. `win2k19`). Then creates/updates a `DataSource` pointing at that PVC, and optionally creates/updates an OpenShift Template.

Do **not** mark a DataVolume Ready unless CDI `status.phase` is `Succeeded`.

## OpenShift and extension versions

Two axes in the catalog: git tag **`v1.x.x`** (semver) and optional branch **`ocp-X.Y`** when PatternFly or APIs diverge. Image tags **always** `<semver>-ocp<major.minor>` (e.g. `1.0.19-ocp4.22`).

- Git: `main` tracks the newest supported minor (currently **4.22**).
- PatternFly 6 on 4.22; do not mix PF majors on one branch.
- **Always publish both minors:** plugin and builder images get `<semver>-ocp4.21` and `<semver>-ocp4.22` (same digest if bits match). Catalog `versions[]` lists both when those tags exist.

**Do not list catalog `versions[].image` until that exact public combined tag exists.**

## Navigation (React Router v6 via v5-compat)

This plugin **does not** register the Community Tools section or hubs. Open from the storefront **Compute** tile or `/community-tools/compute/windows-builder`. Uses `useNavigate` from `react-router-dom-v5-compat` (^6.30.0) for in-page navigation.

## No environment-specific hardcoding

Never bake in a lab StorageClass, ISO URL, VLAN, CIDR, hostname, or cluster domain. Omit PVC `storageClassName` (cluster default) or use a class the user picks from live StorageClasses. Optional: copy a class from an existing DV in `openshift-virtualization-os-images` — still no hardcoded class names. See `.cursor/rules/oct-no-env-hardcoding.mdc`.

Allowed product identity: plugin ID/namespace `oct-windows-builder`, CNV namespaces `openshift-virtualization-os-images` and `openshift` (Templates).

## Builder RBAC (not cluster-admin)

The builder ServiceAccount can get/list/watch/create/update/patch/delete DataVolumes, DataSources, VirtualMachines, VirtualMachineInstances, ConfigMaps, and PersistentVolumeClaims; create `datavolumes/source` (CDI cross-namespace clone; parent `datavolumes` does not imply the subresource); get/list/watch/create/update/patch Templates; get/list StorageClasses; and in `oct-windows-builder` create Jobs/read pods (ISO El Torito patch) plus `datavolumes/source` create in that work namespace. It cannot manage unrelated cluster-scoped resources. Document this in README. Do not log BMC passwords, ISO URL userinfo, Autounattend passwords, or kube tokens.

## Companion images

The deploy bundle (`catalog/deploy/oct-windows-builder.yaml` in the storefront) references a sidecar image with its own independent version. When bumping either image, update both the deploy YAML and this section.

| Image | Current version | Quay repo |
| --- | --- | --- |
| `oct-windows-builder-builder` | **1.0.19** | `quay.io/openshift-community-tools/oct-windows-builder-builder` |

The builder version should match the plugin version. After rebuilding either image, update the deploy YAML in the storefront, rebuild the storefront image, and run `scripts/validate-catalog.sh`. See `oct-release-checklist.mdc`.

## Catalog tile

Storefront `catalog/community.yaml`: `metadata.name: oct-windows-builder`, `consolePlugin: oct-windows-builder`, `spec.href: /community-tools/compute/windows-builder`, `category: compute`, `spec.icon: tiles/oct-windows-builder.svg`. Copy `catalog-tool.yaml` into a storefront PR. **Never catalog a (version, OpenShift minor) row unless that exact combined tag is public.**

## Add must go Ready

Follow **oct-storefront** `docs/extension-standard.md`. Bundle must include plugin Deployment, builder Deployment, Services, RBAC, and ConsolePlugin proxy. Confirm **both** Deployments are Running before calling Add done.

## PatternFly 6

Import from `@patternfly/react-core` ^6. Do **not** import PatternFly CSS. Prefix new CSS `wb-`. Include `CommunityDisclaimer`.

## Verify

```bash
yarn install
yarn verify   # ts-check, check-i18n, check-repo, build (same as CI)
cd builder && go test ./... && go build -o windows-builder .
```

`yarn check-i18n --fix` adds missing translation keys. Contributor workflow and the maintainer-only release steps: [CONTRIBUTING.md](CONTRIBUTING.md).

Do not `oc apply` or push images unless asked.
