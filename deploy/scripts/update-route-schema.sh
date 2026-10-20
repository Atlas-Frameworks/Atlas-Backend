#!/usr/bin/env bash
# Regenerate deploy/schemas/route.openshift.io/route_v1.json (the OpenShift Route schema that
# kubeconform uses) from the Route CRD in openshift/api for the given OpenShift release.
#   deploy/scripts/update-route-schema.sh [release-4.20]
# Conversion, the same as kubeconform's openapi2jsonschema.py in strict mode:
#   - take spec.versions[v1].schema.openAPIV3Schema;
#   - drop "anyOf: null" (present in the generated CRD, invalid JSON Schema);
#   - x-kubernetes-int-or-string -> oneOf [integer, string];
#   - objects with properties and no additionalProperties get additionalProperties: false.
set -euo pipefail

BRANCH="${1:-release-4.20}"
YQ_IMAGE="${YQ_IMAGE:-mikefarah/yq:4.47.1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL -o "$TMP/routes.crd.yaml" \
  "https://cdn.jsdelivr.net/gh/openshift/api@${BRANCH}/route/v1/zz_generated.crd-manifests/routes.crd.yaml"

docker run --rm -v "$TMP:/w" -w /w "$YQ_IMAGE" -o=json '
  .spec.versions[] | select(.name == "v1") | .schema.openAPIV3Schema
  | (.. | select(type == "!!map" and has("anyOf") and .anyOf == null)) |= del(.anyOf)
  | (.. | select(type == "!!map" and .["x-kubernetes-int-or-string"] == true))
      |= . + {"oneOf": [{"type": "integer"}, {"type": "string"}]}
  | (.. | select(type == "!!map" and .type == "object" and has("properties") and (has("additionalProperties") | not)))
      |= . + {"additionalProperties": false}
' routes.crd.yaml >"$ROOT/deploy/schemas/route.openshift.io/route_v1.json"

echo "Wrote deploy/schemas/route.openshift.io/route_v1.json from openshift/api@${BRANCH}"
