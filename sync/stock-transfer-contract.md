# Food stock transfer contract (v1)

Sample only. Not deployed. Endpoint URLs and import codes stay empty until Johan approves a deployment. This file is the contract recipient builders implement. Food is the sender. Service and Workshop each implement the receiver on their own app, with their own users, PINs, storage, and Sheet.

Do not share a database, cache, user list, or PIN. Do not call any action except `importStockTransfer`. Do not reuse the Purshes shortage import or Food's team code for this.

## Apps

| Food place name | `destinationApp` | Receiver |
| --- | --- | --- |
| Services | `tmcservice` | Existing TMC Service app. Public `APP_ID`, not a secret. |
| Workshops | `tmcworkshop` | Confirmed by the Workshop builder. Public `APP_ID`, not a secret. |

One transfer has one destination. A line credited to Service is not also credited to Workshop.

## How Food sends

Same shape as Food's existing Purshes push: the Food Apps Script POSTs `text/plain` JSON. The phone never holds the receiver URL or import code.

Script properties (all empty until an approved deployment). Not live values:

| Property | Meaning |
| --- | --- |
| `SERVICE_STOCK_URL` | Service web app `/exec` URL |
| `SERVICE_STOCK_CODE` | Service import code for this action only |
| `WORKSHOP_STOCK_URL` | Workshop web app `/exec` URL |
| `WORKSHOP_STOCK_CODE` | Workshop import code for this action only |

These four values are empty in this sample. No live URL or import code is stored. While a receiver's URL or code is empty, Food keeps that transfer `queued` and does not mark it accepted.

Food creates a handover only when staff save a new issue to Services or Workshops. Older issues already saved as ordinary kitchen-style issues are not exported. That avoids crediting Service or Workshop twice for history that never left Food.

## Request

`POST` the receiver `/exec` with `Content-Type: text/plain;charset=utf-8`.

```json
{
  "action": "importStockTransfer",
  "code": "<that receiver's import code>",
  "transfer": {
    "id": "stable-transfer-id",
    "v": 1,
    "sourceApp": "fi",
    "sourceIssueId": "stable-transfer-id",
    "destinationApp": "tmcservice",
    "at": "2026-11-08T11:31:00.000Z",
    "by": "Staff display name",
    "qtyScale": 3,
    "lines": [
      {
        "id": "stable-line-id",
        "sourceItemId": "food-item-id",
        "name": "SAMPLE Rice 25kg",
        "unit": "kg",
        "qty": "1.25"
      }
    ]
  }
}
```

Rules:

- `transfer.id` and each `lines[].id` are stable. A retry sends the same ids. Food's `transfer.id` is the issue id. Each line id is the Food movement id.
- `sourceIssueId` equals `transfer.id`.
- `destinationApp` is `tmcservice` or `tmcworkshop`. The receiver rejects any other value with `wrong_app` and writes nothing.
- Food freezes this `transfer` object the first time it sends it. A retry sends that same object. A later edit on the phone does not change it.
- `qty` is a decimal string. Dot is the separator. No exponent. At most 3 digits after the dot (`qtyScale` is 3). Food rounds with half-up to 3 places before sending (`1` , `0.5` , `1.25`). The value must be greater than 0.
- `name` is at most 120 characters. `unit` is at most 20. At most 40 lines.
- Ids match `^[A-Za-z0-9_-]{4,64}$`.
- `at` is ISO-8601 UTC. `by` is the staff display name for the audit line only.

The body must not contain PINs, PIN hashes, session tokens, team codes, user records, permissions, or instructions to edit anything except this stock credit.

## Response

Always JSON.

Accepted, including a retry of a transfer the receiver already applied:

```json
{ "ok": true, "transferId": "stable-transfer-id", "result": "accepted" }
```

```json
{ "ok": true, "transferId": "stable-transfer-id", "result": "duplicate" }
```

`duplicate` means the credit is already there. It is success for Food. It must not add the quantity again.

Refused. The receiver has written nothing for this transfer:

```json
{ "ok": false, "error": "bad_code" }
```

`error` is one of `bad_code`, `wrong_app`, `bad_request`, `bad_qty`, `ambiguous_item`, `busy_try_again`.

If this `transfer.id` was already applied and the `transfer` object is not the same as the one that was applied, return `bad_request` and do not change the credit. The same object again is `duplicate`.

If a Food item id is already bound and this line's `unit` is different, return `bad_request` and do not convert the quantity. The bound unit stays as it was.

## Sender status

Food shows one of these. `accepted` is set only after a response with `ok: true`, a matching `transferId`, and `result` of `accepted` or `duplicate`.

| Situation | Status | Stock on the receiver |
| --- | --- | --- |
| Saved on the phone, or the link is not configured, or the network failed, or the code was wrong | `queued` | No credit |
| Receiver refused (`wrong_app`, `bad_qty`, `ambiguous_item`, …) | `rejected` | No credit |
| Receiver returned `accepted` or `duplicate` | `accepted` | Credited once |

Queued is not received. Food must not show the goods as in Service or Workshop stock while the status is `queued` or `rejected`.

Food deducts its own Store Room stock once, when the issue is saved, as one movement id. Retries resend the handover. They do not create a second movement. A receiver rejection does not silently put the food back. Staff still see the error and can retry the same transfer id after the receiver can accept it.

Food remembers each accepted transfer id in script properties `HANDOVER_ACK_0`, `HANDOVER_ACK_1`, and so on. Each value stays at or under 8000 bytes, under the Apps Script per-property cap. A new id that does not fit opens the next property. Older ids are not removed. A legacy `HANDOVER_ACK` value is still read and is not rewritten into one growing blob. The phone's copy of the status is not trusted. Once an id is in that list, a later `bad_request` does not set the Food row back to rejected and does not send a second credit.

## Receiver item mapping

Do this inside the receiver, in one lock, all or nothing. If any line fails, write nothing and return the error.

1. If `transfer.id` was already applied, the same `transfer` object returns `duplicate` and a different one returns `bad_request`. Do not change quantities either way.
2. For each line, find the local item already bound to `sourceApp + sourceItemId` (`fi` + the Food item id).
3. If it is bound to a different unit, return `bad_request` and write nothing. Do not convert. If the unit matches, credit that item.
4. If it is not bound, look for local items with the same unit and the same name after trim, case-fold, and accent-fold.
   - None: create one local item whose key is this Food item id, then credit it, then store the binding.
   - One: bind that item and credit it.
   - More than one: return `ambiguous_item` and write nothing. Do not pick a winner by name.
5. Add the `qty` string once, using 3 decimal places (integer thousandths are a safe way). Do not add the quantity again for the same line id.

Name alone is not identity. Two local items with the same name must not both be eligible. A later transfer for the same Food item id uses the binding from step 2, so a renamed local item still receives the credit.

Service parts are keyed by part number today. This contract does not overwrite a part number. Binding a Food item onto an existing part is allowed only by the single name-and-unit match above, or by a binding stored earlier. Otherwise the receiver creates its own stock line for that Food item id.

## What the receiver builder implements

On the Service app (`tmcservice`) and the Workshop app (`tmcworkshop`):

- Own Sheet, own script, own import code. Not Food's code and not each other's.
- `doPost` accepts only `importStockTransfer` for this code. The code cannot sync, cannot change users, and cannot run other actions.
- The checks and the credit rules above.
- A visible stock line staff can count, plus the transfer id and line ids stored so a retry is recognized.

Food will not call the receiver until the matching script properties are filled in a deployment Johan has approved.

## Food sample in this repo

The sample sender queues the handover and pushes it only when those properties are set. With them empty, a new issue still deducts Food stock and stays `queued`. The sample does not contain a receiver, and it does not scan old Services or Workshops issues.
