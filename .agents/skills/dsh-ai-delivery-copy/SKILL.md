---
name: dsh-ai-delivery-copy
description: Draft commit messages and pull-request title/body with the host's lightweight model call, keep generation read-only until a person confirms edited text, and fall back without blocking writes. Use when adding AI-drafted delivery copy, designing a generate → edit → confirm dialog, wiring best-effort generation into an automated delivery tier, or debugging a draft editor that writes too early, restores a cleared field, or hangs on timeout; pure feature work with no drafted copy does not need it.
---

# AI-drafted delivery copy

Treat every generated string as a **draft** (the leading word). A draft has no authority: the human's confirmation and the existing write gate do.

## Steps

1. **Separate generating from writing.** Put generation behind a read-only route or function; the write goes through the existing authorize-then-write path with the edited value. Give the generation route the same session/verdict/state guards as the write route so a direct request cannot draft around the gate. Done when a generated request produces no git write and only the confirm step can write.
2. **Use one bounded, one-shot model call.** Route through the host's lightweight `llm` service and its default model selection; no task Agent, no skill loading, no model selector. Cap the input diff and each output field, mark all fetched text as data (never instructions), demand a single plain line for a commit message and strict JSON with title/body for a PR. Done when a missing service, empty or unparsable output, non-terminal finish, or timeout returns the caller's fallback instead of throwing or blocking.
3. **Build a four-state editor.** Show generating (spinner + status text), editable draft, fallback (warning + original default copy), and submitting. Keep confirm disabled while generating, on a trimmed-empty required field, and during submit. Cancel must discard a late response. Done when a cancelled dialog triggers no write, a late result cannot repopulate it, an empty trimmed value cannot be confirmed, and the write request contains exactly the edited text.
4. **Keep automated tiers best-effort.** In an automatic delivery path, draft only on the real write occasion (a genuinely dirty tree, the first PR) and fall back to the former default on any failure. Never let generation change a gate, a head or an audit decision; record the copy source so the result is explainable. Done when removing the generator entirely leaves the delivery outcome identical apart from the text.
5. **Preserve explicit empty values.** Distinguish "field was cleared" from "field was absent": an empty string is a real edit, only a missing or wrongly-typed value falls back. Done when clearing an optional body reaches the write as an empty string and survives the readback.
6. **Verify order, not just outcome.** Inject the model port in unit tests and mutate each guard (remove the fallback, the empty-string check, the late-result guard) to see the matching assertion go red. On a real host, watch the request sequence: generation first, authorize and write only after confirm; check the spinner, editable fields, warning text and readback. Done when the request order and the written values are reported as observed, and anything not reproduced is marked unverified.

## Reference: failure modes worth checking

- A dialog that references a title variable it never received crashes the whole page at every entry. Render each entry in a test and assert the dialog title equals its confirm label.
- A development-mode duplicate generation request is a cost/question, not proof of a broken write gate. Report the observed count and whether the production build behaves the same; re-state separately that writes still happened only after confirmation.
- Timeout guards on both sides need different windows: the backend bounds the model call, and the client keeps a slightly longer safety net so a slow response is not overwritten by a local timeout.
- Mirrored copy keys must stay byte-identical across the runtime dictionaries and packaged locale files; placeholder tokens must match. Assert the added key list and the cross-copy consistency, never a frozen total.
- "AI wrote it" and "the default was filled in" are different user-visible states. Report which one was actually seen; an offline-only failure path stays labelled offline.
