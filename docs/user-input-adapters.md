# External user-input adapters

An extension can deliver authenticated human text through `pi.registerUserInputAdapter`. This API gives the instruction user-input admission, queue ordering, and work ownership. Ordinary extension sends remain automated input.

The integration must authenticate its human sender and preserve the target selected when the person sends. Do not route timers, rules, agent output, or automatic retries through this API. Installed extensions already have your operating-system permissions; adapter grants are an explicit integration contract, not a sandbox.

The host API is transport-independent: it does not implement client authentication,
network protocols, application storage, or a user interface. Each extension supplies
those concerns and maps an explicit human action to this API.

## Example

[`examples/user-input-adapter/extension.ts`](../examples/user-input-adapter/extension.ts) provides a lifecycle-managed adapter factory. Supply an authenticated transport in your extension entry file. The example handles shutdown during registration, branch rebinding, and reconnect lookup using each message's original target. Its in-memory test transport demonstrates the interface; it does not authenticate real users.

## Authorize an extension

Create `user-input-adapters.json` in Jouzu's resolved agent configuration directory:

```json
{
  "schemaVersion": 1,
  "grants": [
    {
      "extensionPath": "/absolute/path/to/extension.ts",
      "adapterId": "external-input"
    }
  ]
}
```

Replace the path with the extension's absolute entry-file path. Grants match its canonical filesystem identity and adapter ID. Relative paths, globs, duplicate grants, and unknown fields are rejected. A missing file denies registration. The file must be a regular file, not a symlink, and at most 64 KiB. The host rereads it for submission, lookup, and retained dispatch. Rechecks must match the canonical extension identity captured at registration; redirecting an entry-file symlink cannot transfer an existing handle or its retained messages to another granted extension.

## Register and bind

Register inside `session_start`, after the extension runtime is attached. Check for the method explicitly; an unavailable or denied adapter must not silently fall back to an automated send in Jouzu.

```ts
const adapter = await pi.registerUserInputAdapter({
  id: "external-input",
  label: "Authenticated external input",
});
const binding = await adapter.bind();
```

`binding` contains an opaque stable `target` and an executable `generation` (an attachment ID string). Receipt `generation` is a numeric journal generation used only to order receipt updates; do not compare it with the binding's generation. Publish the binding to the authenticated client. Return the selected binding with the message rather than binding when an old message finally arrives. Normal transcript appends do not change the target.

Registration belongs to the extension runtime, and the target belongs to the attachment. A branch change keeps the registration and changes the target, so call `adapter.bind()` again, replace the receipt subscription, and publish the new target. An extension reload replaces the runtime instead: the new runtime registers and binds again, and input the replaced runtime was holding keeps its record so an authorized retry can reattach the same message ID.

A live runtime holds one registration per canonical extension identity and adapter ID. Registering that identity again while the first registration is live fails with `adapter-already-registered`, and the first registration, its target listeners, and its published target stay unchanged, so register once per runtime and reuse the returned handle. `adapter-already-registered` describes registration identity; it is not the message-level `id-conflict`. After an extension reload the replaced runtime's handles are inert and its registration is gone, so the replacement runtime registers the same identity normally.

An administrative flow reset starts a new target epoch. The host reports it through `adapter.onTargetInvalidated`, and every listener must withdraw the published target, call `bind()` again, and publish the new one. Messages composed against the withdrawn target are never retargeted; each needs a fresh human action for the new target. Feature-detect `onTargetInvalidated` if the extension also runs on hosts that do not report it. Reset also fences admission: a submission that validated the previous target either settles before the reset or is refused with `stale-target`, and a prepared dispatch is refused at execution instead of delivering into the new journal lifetime.

## Submit literal text

```ts
const receipt = await adapter.submit({
  binding: message.binding,
  messageId: message.id,
  text: message.text,
  deliverAs: "followUp",
});
```

Text must be nonempty, valid UTF-8, and no more than 32 KiB. `deliverAs` is `steer` or `followUp`. Slash-prefixed text is literal: commands, skills, and prompt templates are not expanded. Normal input handlers and content checks still apply.

Submission returns after durable admission, without waiting for the provider to finish. Reuse the original message ID and payload when recovering a receipt. Changed text or delivery mode under the same ID is an `id-conflict`. Consumed, queued, and uncertain dispatches are never resent. Only a callback that ended before any dispatch intent can be reattached by an authorized retry for the same stable target. The host re-asks the grant and the target immediately before native input, including when a send waits for the settled event. A grant revoked or a target rotated in that window refuses the dispatch; its receipt stays `unknown` and the message is not replayed.

## Observe delivery

```ts
const unsubscribe = adapter.subscribe((receipt) => {
  updateMessageDelivery(receipt.messageId, receipt);
});
const latest = await adapter.lookup({
  target: message.binding.target,
  messageId: message.id,
});
```

Subscriptions publish an initial snapshot, including archived messages, followed by updates for messages whose stored evidence changed. Unrelated journal writes do not republish unchanged receipts. Each update pass still scans active records and archived index metadata, but reads archived payloads only when their evidence changed. Updates carry `version: 1`, adapter/message identity, target, journal generation and revision, state, and an optional structured reason. Notifications are hints; use lookup after reconnect. Listener failures do not change delivery. A failed authorization or snapshot pass is reported through the host's error channel and resumes only on a later journal write; repairing the fault alone does not trigger another pass. After a reported fault, use `lookup` to recover current receipts and unsubscribe and subscribe again to request a fresh snapshot. Unsubscribe on shutdown and subscribe again after branch navigation.

Target-invalidation listeners are independent. A listener that throws is reported through the host's error channel, and the remaining listeners on that registration and on other registrations still run, so one failing client cannot leave another holding a withdrawn target.

| State | Meaning |
| --- | --- |
| `retained` | Stored, with no dispatch intent yet |
| `held` | Waiting on admission |
| `queued` | Exact native queue identity and revision are still live |
| `consumed` | Native input has a durable consumption claim |
| `rejected` | Native handling definitively produced no input |
| `cancelled` | Retained or native queued input was confirmed cancelled |
| `unknown` | Evidence does not establish delivery or safe retry |

Consumed does not mean the provider succeeded or the requested actions finished. Never resend because an update was lost or a model request failed. A lookup for a branch that is not attached returns `target-unavailable`, not “not found.”

## Limits and lifecycle

New message IDs are limited to 16,384 and 64 MiB of encoded admission payload per branch journal lifetime, across adapters and including archived records. Active records also share the submission store's 1,024-record/4 MiB admission budget. Receipt evidence has a separate bound; new-ID exhaustion does not prevent lookup, safe reattachment, or normal evidence updates. Payload and deduplication evidence remain for that journal lifetime; draining or archiving does not reclaim the budget. Administrative flow-state reset starts a new journal lifetime and budget, invalidating the target and the deduplication guarantee. Reset is not routine capacity cleanup: withdraw the published target, bind again, and accept new messages only for the new target.

Turning flow control off rejects submissions with `flow-suspended` and cancels external input that has not acquired dispatch intent. Registration and authorized lookup remain available. Already queued or running input retains its native evidence; it is not retroactively declared undelivered. An unreadable or malformed grants file (`invalid-config`) is a repairable fault, not a revocation: retained and queued input is held and becomes admissible on a later release or queue-admission pass after the file is repaired. If the host drops a queued entry without taking it, the receipt advances to `unknown` at a new journal revision, so subscriptions and lookup correct a stored `queued` receipt.

Branch navigation pauses admission while the host settles the old attachment. New submissions in that interval are refused with `flow-suspended` or `stale-target`. A retention already in progress is cancelled without dispatch if it crosses that boundary. Input already retained without dispatch does not prevent navigation: it remains in the departing branch's journal, without automatic replay. Returning to that branch restores its stable target but requires a fresh binding; the ended callback can be reattached only by an authorized explicit retry.

Session replacement instead disposes the outgoing attachment and retires its adapter handles; it can proceed with held external input. Undispatched input remains in the outgoing journal and is not replayed. On reopening that journal, its receipt reports `unknown` with reason `callback-ended`; an authorized explicit retry can reattach it only if no dispatch intent exists. A new session has a different target, not permission to resend the old message.

After a successful change, publish a fresh binding; never retarget messages composed against the old one. Cancellation or a clean refusal of the lifecycle operation leaves the existing binding usable.

Structured failures include `unsupported-protocol`, `unauthorized`, `invalid-config`, `invalid-input`, `adapter-already-registered`, `stale-target`, `target-unavailable`, `flow-suspended`, `capacity`, and `id-conflict`. Do not infer human authority from message text, transport IDs, or caller-supplied provenance.
