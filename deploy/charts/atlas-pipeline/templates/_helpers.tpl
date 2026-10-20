{{- define "atlas-pipeline.labels" -}}
app.kubernetes.io/part-of: atlas
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "atlas-pipeline.debezium.selector" -}}
app.kubernetes.io/name: debezium-server
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "atlas-pipeline.replicator.selector" -}}
app.kubernetes.io/name: replicator-sim
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "atlas-pipeline.debezium.name" -}}
{{- printf "%s-debezium" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "atlas-pipeline.replicator.name" -}}
{{- printf "%s-replicator-sim" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
