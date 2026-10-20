# Debezium Server for the POC (task I-03).
# In Debezium 3.7 the Outbox Event Router (io.debezium.transforms.outbox.EventRouter) lives in
# debezium-connect-plugins, which the official image ships in lib_opt/, NOT on the classpath.
# Without this the server fails with "ClassNotFoundException: io.debezium.transforms.outbox.EventRouter".
# (run.sh's ENABLE_DEBEZIUM_SCRIPTING=true would add all of lib_opt/, including a second copy of
# debezium-connector-common; copying only this jar keeps the classpath clean.)
ARG DEBEZIUM_VERSION=3.7.0.Final
FROM quay.io/debezium/server:${DEBEZIUM_VERSION}
ARG DEBEZIUM_VERSION
RUN cp /debezium/lib_opt/debezium-connect-plugins-${DEBEZIUM_VERSION}.jar /debezium/lib/
