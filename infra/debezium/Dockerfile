FROM quay.io/debezium/server:3.7.0.Final

# Debezium Server bundles optional SMTs outside the runtime classpath.
RUN cp /debezium/lib_opt/debezium-connect-plugins-3.7.0.Final.jar /debezium/lib/
