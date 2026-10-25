# v2 record format

One record per file (`data/<name>.json`, v1 shape) is converted to one JSON object.

## v1 shape

```json
{
  "id": 3,
  "first_name": "Ada",
  "last_name": "Lovelace",
  "email": "ada@example.com",
  "phone": "+1-555-0100",
  "address": {"street": "12 Main St", "line2": "Apt 4", "city": "Springfield",
              "state": "IL", "zip": "62701"},
  "balance_cents": "1234.567",
  "currency": "usd",
  "tags": ["math", "history"]
}
```

Required: `id`, `first_name`, `last_name`, `currency`, `balance_cents`,
`address.street`, `address.city`, `address.state`, `address.zip`.
Optional: `email`, `phone`, `tags`, `address.line2`.

`id` is a positive integer, unique within the dataset. `balance_cents` is a
decimal string of cents (integer or fractional, optional leading `-`), never a
JSON number. `currency` is a 3-letter code in any case.

## v2 shape

```json
{
  "id": 3,
  "name": "Lovelace, Ada",
  "email": "ada@example.com",
  "phone": "+1-555-0100",
  "street": "12 Main St",
  "line2": "Apt 4",
  "city": "Springfield",
  "state": "IL",
  "postal_code": "62701",
  "balance": "12.35",
  "currency": "USD",
  "tags": ["math", "history"]
}
```

Rules:

- `name` is `"<last_name>, <first_name>"` (comma, single space).
- `address` is flattened: `street`, `line2`, `city`, `state` keep their names,
  `zip` becomes `postal_code`.
- `currency` is upper-cased.
- `balance` is the cents value divided by 100, quantized to 2 decimals with
  round-half-away-from-zero (Decimal `ROUND_HALF_UP`), rendered as a plain
  string with exactly 2 decimals and no exponent. Examples:
  `"123456"` -> `"1234.56"`, `"250.5"` -> `"2.51"`, `"-1234.5"` -> `"-12.35"`,
  `"0.004"` -> `"0.00"`, `"0"` -> `"0.00"`.
- Optional fields that are absent from v1 are absent from v2 (`email`, `phone`,
  `address.line2`). `tags` is the exception: absent means `[]`.
- `tags` keeps its original order.

## Output files

- `out/v2/<id>.json` with the id zero-padded to 4 digits, e.g. `0003.json`
- `out/errors.txt`
- Serialization is `json.dumps(obj, indent=2, sort_keys=True,
  ensure_ascii=False)` followed by exactly one `\n`; UTF-8, LF only.

## Error codes

A record that fails validation is reported, never dropped silently, and is not
written to `out/v2/`. One line per bad record in `out/errors.txt`:

```
<source file name>: <code>
```

Lines are sorted ASCII by file name. Codes:

- `bad_json` — file is not valid JSON, or the root is not an object
- `bad_address` — `address` is present but not an object
- `missing_field:<path>` — required field absent, e.g. `missing_field:last_name`,
  `missing_field:address.city`
- `bad_id` — `id` is not a positive integer (booleans are not integers)
- `bad_currency` — `currency` is not a string
- `bad_balance` — `balance_cents` is not a string, or not a decimal number
- `bad_tags` — `tags` is present but not a list of strings

Files not ending in `.json`, and subdirectories, are ignored.
