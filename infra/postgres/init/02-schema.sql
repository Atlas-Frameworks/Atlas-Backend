-- Starter POC schema (task W-01 owns, reviews and finalizes this file).
-- Example domain: countries, connections (login presets), airports, airplanes.
-- Every root entity has `version bigint`, incremented on ANY change to the entity or its child rows.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE TABLE countries (
  id         uuid PRIMARY KEY,
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  region     text NOT NULL,
  version    bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A "connection" is a shared login preset: a list of countries plus other criteria.
CREATE TABLE connections (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  criteria   jsonb NOT NULL DEFAULT '{}'::jsonb,  -- e.g. {"minAltitude": 1000, "airlines": ["LY"]}
  version    bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connection_countries (
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  country_id    uuid NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  PRIMARY KEY (connection_id, country_id)
);
CREATE INDEX connection_countries_country_idx ON connection_countries (country_id);

CREATE TABLE airports (
  id          uuid PRIMARY KEY,
  country_id  uuid NOT NULL REFERENCES countries(id),
  iata        text NOT NULL,
  name        text NOT NULL,
  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- nested data, e.g. {"runways":[{"length":3200,"surface":"asphalt"}]}
  version     bigint NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX airports_country_idx ON airports (country_id);
CREATE INDEX airports_runway_count_idx ON airports ((jsonb_array_length(details -> 'runways')));

CREATE TABLE airplanes (
  id            uuid PRIMARY KEY,
  callsign      text NOT NULL,
  airline       text NOT NULL,
  aircraft_kind text NOT NULL,
  country_id    uuid NOT NULL REFERENCES countries(id),
  airport_id    uuid REFERENCES airports(id),          -- origin / current airport
  lat           double precision NOT NULL,
  lon           double precision NOT NULL,
  altitude      integer NOT NULL,
  heading       real NOT NULL,
  speed         real NOT NULL,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- nested data and arrays
  version       bigint NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX airplanes_country_idx ON airplanes (country_id);
CREATE INDEX airplanes_airport_idx ON airplanes (airport_id);
CREATE INDEX airplanes_airline_idx ON airplanes (airline);
CREATE INDEX airplanes_kind_idx ON airplanes (aircraft_kind);
CREATE INDEX airplanes_callsign_trgm_idx ON airplanes USING gin (callsign gin_trgm_ops);

-- Child table: proves that a child-row change bumps the root version and reaches views.
CREATE TABLE airplane_crew (
  airplane_id uuid NOT NULL REFERENCES airplanes(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL,
  role        text NOT NULL,
  name        text NOT NULL,
  PRIMARY KEY (airplane_id, member_id)
);
