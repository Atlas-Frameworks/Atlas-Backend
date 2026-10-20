#!/usr/bin/env bash
# Lint and render every chart/values combination, then validate the output with kubeconform.
# Uses pinned Docker images by default (no local installs needed); set HELM=helm and
# KUBECONFORM=kubeconform to use local binaries instead. Used by CI (.github/workflows/ci.yml).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

HELM_IMAGE="${HELM_IMAGE:-alpine/helm:3.22.0}"
KUBECONFORM_IMAGE="${KUBECONFORM_IMAGE:-ghcr.io/yannh/kubeconform:v0.8.0}"
# OpenShift Container Platform 4.20 ships Kubernetes 1.33.
KUBE_VERSION="${KUBE_VERSION:-1.33.0}"

if [[ -n "${HELM:-}" ]]; then
  helm_cmd=("$HELM")
else
  helm_cmd=(docker run --rm -v "$ROOT:/w" -w /w "$HELM_IMAGE")
fi
if [[ -n "${KUBECONFORM:-}" ]]; then
  kubeconform_cmd=("$KUBECONFORM")
else
  kubeconform_cmd=(docker run --rm -i -v "$ROOT:/w" -w /w "$KUBECONFORM_IMAGE")
fi

OUT="deploy/.rendered"
rm -rf "$OUT"
mkdir -p "$OUT"

# name | release | chart | extra helm args
cases=(
  "tracks|tracks|deploy/charts/view-service|-f deploy/charts/view-service/values-tracks.yaml"
  "reference|reference|deploy/charts/view-service|-f deploy/charts/view-service/values-reference.yaml"
  "tracks-custom-metric|tracks|deploy/charts/view-service|-f deploy/charts/view-service/values-tracks.yaml --set autoscaling.customMetric.enabled=true"
  "tracks-no-hpa-shared-port|tracks|deploy/charts/view-service|-f deploy/charts/view-service/values-tracks.yaml --set autoscaling.enabled=false --set ports.ws=3000 --set route.host=tracks.apps.example.com"
  "pipeline|atlas|deploy/charts/atlas-pipeline|"
)

for chart in deploy/charts/view-service deploy/charts/atlas-pipeline; do
  echo "== helm lint $chart"
  # view-service needs serviceName; lint with the tracks values.
  extra=()
  [[ "$chart" == */view-service ]] && extra=(-f deploy/charts/view-service/values-tracks.yaml)
  "${helm_cmd[@]}" lint --strict "$chart" ${extra[@]+"${extra[@]}"}
done

for c in "${cases[@]}"; do
  IFS='|' read -r name release chart args <<<"$c"
  echo "== helm template $name"
  # shellcheck disable=SC2086 # args is a list of flags
  "${helm_cmd[@]}" template "$release" "$chart" --namespace atlas --kube-version "$KUBE_VERSION" $args \
    >"$OUT/$name.yaml"
done

echo "== kubeconform"
# Core kinds from the upstream schemas; the OpenShift Route schema is vendored under
# deploy/schemas (see deploy/README.md for its source).
"${kubeconform_cmd[@]}" \
  -strict -summary -kubernetes-version "$KUBE_VERSION" \
  -schema-location default \
  -schema-location 'deploy/schemas/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  "$OUT"/*.yaml
