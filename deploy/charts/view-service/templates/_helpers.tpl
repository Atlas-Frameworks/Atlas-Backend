{{/* Service name, required: it prefixes Redis keys and names the worker list. */}}
{{- define "view-service.serviceName" -}}
{{- required "serviceName is required (e.g. tracks)" .Values.serviceName -}}
{{- end -}}

{{/* Base name of every resource; pods are "<fullname>-<ordinal>" and those are the worker names. */}}
{{- define "view-service.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 52 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" (include "view-service.serviceName" .) (default "view" .Values.nameOverride) | trunc 52 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "view-service.headlessName" -}}
{{- printf "%s-peers" (include "view-service.fullname" .) -}}
{{- end -}}

{{- define "view-service.selectorLabels" -}}
app.kubernetes.io/name: view-service
app.kubernetes.io/instance: {{ .Release.Name }}
atlas.io/service: {{ include "view-service.serviceName" . }}
{{- end -}}

{{- define "view-service.labels" -}}
{{ include "view-service.selectorLabels" . }}
app.kubernetes.io/part-of: atlas
app.kubernetes.io/component: view-worker
app.kubernetes.io/version: {{ default .Chart.AppVersion .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "view-service.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{/* True when the WebSocket server has its own port. */}}
{{- define "view-service.separateWsPort" -}}
{{- if ne (int .Values.ports.ws) (int .Values.ports.http) -}}true{{- end -}}
{{- end -}}
