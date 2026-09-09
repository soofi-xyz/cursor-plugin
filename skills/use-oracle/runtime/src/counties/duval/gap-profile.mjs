export const duvalGapProfile = Object.freeze({
  countyKey: "duval",
  countyName: "Duval",
  countyFips: "12031",
  sourceSystem: "duval_appraiser",
  expectedPropertyCount: 403_885,
  expectedPermitCount: 3_415_527,
  expectedLinkedPermitCount: 3_353_717,
  expectedPermitPropertyCount: 336_451,
  expectedOwnerOccupiedSourceCount: 404_023,
  expectedSunbizSourceCount: 691_288,
  expectedSunbizLinkCount: 73_127,
  expectedSunbizPropertyCount: 42_184,
  expectedBbbPropertyCount: 171_134,
  expectedOwnerOccupiedSplit: Object.freeze({
    true: 212_959,
    false: 0,
    null: 190_926,
  }),
  frozenInputs: Object.freeze({
    queryTable: Object.freeze({
      bytes: 167_302_003,
      sha256:
        "3f43ef083328d193ba55bee7ec4279f6a6ba371d8b6279ac6af01864419aa56a",
    }),
    permitTable: Object.freeze({
      bytes: 1_108_488_548,
      sha256:
        "6cd60ee4ea6337f3fa55a7a515b516eacef7b7761a3be06078da4b2c81267c5e",
    }),
    ownerOccupiedNal: Object.freeze({
      bytes: 21_825_424,
      sha256:
        "4504bf852552ad24db03ed565d88b6feb39eef750240a14a1c1324bad53df493",
    }),
    sunbizHandoff: Object.freeze({
      bytes: 1_703_864,
      sha256:
        "35d5f36ddb7f9cd6754a22d90513af2e33eb8a3016f332d7475bf1dbdc3e4c89",
    }),
  }),
  overture: Object.freeze({
    release: "2026-08-19.0",
    boundarySource: "tiger/tl_2024_us_county",
    includeEmails: false,
    includePhones: false,
  }),
  publication: Object.freeze({
    propertyDocumentsBucket: "elephant-oracle-open-data-duval",
    propertyDocumentsIpnsLabel: "oracle-open-data-duval",
    placesBucket: "elephant-oracle-open-data-duval-places",
    placesIpnsLabel: "oracle-open-data-duval-places",
    queryTableBucket: "elephant-oracle-query-table",
    queryTableIpnsLabel: "oracle-query-table-duval",
  }),
  protectedPublications: Object.freeze({
    queryTable: Object.freeze({
      networkKey:
        "k51qzi5uqu5dle7swd06u9ebrgw375b5vhhhtiiz7un7udfsar0rci53x2w5y4",
      frozenCid: "QmTfaoKg7yUfHKLcsor1yc7cTZnBcW3CdkjG8je7JQwfSS",
      allowedRepoints: 1,
    }),
    permitTable: Object.freeze({
      label: "oracle-permit-table-duval",
      networkKey:
        "k51qzi5uqu5dll7nwe1o7s1htngeoxrou8k593xieuziw9521444vh3pd7v4y1",
      frozenCid: "QmTKvaWBmwaVGQheEAWSw59EXZqifPxNxaXx5AMpsSqM62",
      allowedRepoints: 0,
    }),
    coverage: Object.freeze({
      label: "oracle-dataset-coverage-duval",
      networkKey:
        "k51qzi5uqu5dgqc52fnea1o42e27dr4os0mrdf5ixonuv8kdztdnxclflazf4w",
      frozenCid: "QmcVZjQuAivZoyWMpMdgRfcATQb3tujMNk5FVHvGVNVWDy",
      allowedRepoints: 0,
    }),
  }),
});
