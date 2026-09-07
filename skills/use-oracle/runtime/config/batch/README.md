# County enrichment Batch configuration

`request.example.json` is a shape-valid template, not a runnable county
request. Replace its example county, immutable input objects, provenance, and
reviewed scope before planning or submission.

The `sunbiz-bbb-reconcile` pipeline applies to Florida counties because
Sunbiz is Florida's corporate registry. BBB harvesting is geographically
configurable, but selecting a non-Florida county requires a different
corporate-registry pipeline rather than relabeling Sunbiz data.

The ZIP prefixes and complete BBB category objects must exactly match the
selected registered county profile. The operator validates that match and the
configured cost ceiling before making any submission calls.

Stage submissions use deterministic job names plus immutable S3 receipts, so
an interrupted operator command can safely be rerun and adopt the matching
Batch jobs. Do not run concurrent independent operators for the same request;
the ledger recovers process crashes but is not a distributed execution lock.

Keep submission receipts, recovery evidence, and production request snapshots
in immutable S3 storage and pull-request evidence. Do not add them to this
framework configuration directory.
