# Vendor registry

One JSON file per vendor in `vendors/`, named `<id>.json`, validated by `server/model-registry.ts` (the schema is the `descriptor` object there). Adding a plain vendor is a file here plus nothing else.

- `status` is `candidate` until the vendor has passed a live check through a small, expiring grant; only `verified` and `supported` vendors may serve traffic. Every file in this folder is a candidate today: the base URLs and auth come from official documentation read by web research and have not been tested against a live endpoint.
- `substitution` says whether the vendor can answer with a model other than the one requested (`none-documented`, `owner-defined`, `possible`, `unknown`). Only `none-documented` and `owner-defined` vendors can back a guaranteed grant. Hosters stay `unknown` until verified one by one.
- `models` is curated data: a model gets a `family` and `aliases` (including dated snapshots) only here. A model discovered from the vendor's own list has family `unknown`.
- Base URL templates take named `fields`, each with a fixed validator, so a value can never add a host, port, path or credentials.
- The registry is not loaded by the broker yet. When it is, `registry/` must be added to the release payload in `scripts/package.sh`.
