CREATE TABLE import_instrument_memory (
  label_key text NOT NULL,
  currency text NOT NULL,
  identity jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(label_key, currency)
);

-- Recover explicit selections made before durable memory was introduced.
WITH confirmations AS (
  SELECT e.created_at, e.id,
    trim(regexp_replace(regexp_replace(lower(labels.name), '[^a-z0-9]+', ' ', 'g'), '\mhealth\s+care\M', 'healthcare', 'g')) AS label_key,
    coalesce(corrected.value->>'currency', e.extraction->'merged'->>'currency') AS currency,
    jsonb_build_object('symbol',corrected.value->>'symbol','name',coalesce(corrected.value->>'name',corrected.value->>'symbol'),
      'isin',corrected.value->>'isin','providerKey',corrected.value->>'providerKey','providerExchange',corrected.value->>'providerExchange') AS identity
  FROM import_extractions e
  JOIN LATERAL (
    SELECT extraction FROM import_extractions prior
    WHERE prior.import_session_id=e.import_session_id AND prior.artifact_index<e.artifact_index
    ORDER BY prior.artifact_index DESC LIMIT 1
  ) previous ON true
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.extraction->'candidate'->'positions','[]'::jsonb)) edit
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.extraction->'merged'->'positions','[]'::jsonb)) corrected
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(previous.extraction->'merged'->'positions','[]'::jsonb)) original
  CROSS JOIN LATERAL (VALUES(original.value->>'name'),(corrected.value->>'name')) labels(name)
  WHERE e.extraction->>'kind'='edit'
    AND (nullif(edit.value->>'symbol','') IS NOT NULL OR nullif(edit.value->>'isin','') IS NOT NULL)
    AND lower(edit.value->>'candidateId')=lower(corrected.value->>'candidateId')
    AND lower(edit.value->>'candidateId')=lower(original.value->>'candidateId')
    AND nullif(corrected.value->>'symbol','') IS NOT NULL
    AND corrected.value->>'matchStatus' IS DISTINCT FROM 'ambiguous'
    AND labels.name IS NOT NULL
)
INSERT INTO import_instrument_memory(label_key,currency,identity,updated_at)
SELECT DISTINCT ON(label_key,currency) label_key,currency,identity,created_at
FROM confirmations WHERE currency IS NOT NULL AND label_key<>''
ORDER BY label_key,currency,created_at DESC,id DESC;
