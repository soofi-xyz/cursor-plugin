export const duvalGapProfile = Object.freeze({
  countyKey: "duval",
  countyName: "Duval",
  countyFips: "12031",
  sourceSystem: "duval_appraiser",
  expectedPropertyCount: 403_885,
  expectedPermitCount: 3_415_527,
  expectedSunbizPropertyCount: 42_184,
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
      frozenCid: "QmR139dymemJaxD5u8Ftx9mc2fm7KxTDeN4JC3KshMnACZ",
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
      frozenCid: "QmReJrVy627vgRemjDy9N3NTnuCxYVqTr1oraAXmJLmV3y",
      allowedRepoints: 0,
    }),
  }),
});
