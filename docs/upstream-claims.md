# Before Blaming an Upstream System

Written after getting it wrong, on 2026-08-03.

A merchant on `dev-emre2` bought Pro. The app refused it. Our own log said
`{"reason":"NO_MATCHING_SUBSCRIPTION","subscriptionCount":0}`, which was read as "ikas returns no
subscriptions", and a support request was filed on that basis. ikas replied that a licence cannot be
empty while the UI shows the plan — and they were right. The real response carried the subscription;
`HttpIkasLicenceAdapter` discarded it before anything else could see it, because it filtered on
`authorizedAppId`, which ikas leaves `null` on a plan bought through "Planı Yönet".

The bug cost an afternoon. Reporting it as someone else's bug cost credibility, which is dearer.

## What actually went wrong

The log field was named for the thing being counted (`subscriptionCount`) but measured something
else: how many records survived our own filtering. Every layer downstream of that filter, including
the operator reading the log, inherited the mistake. Nothing in the system could distinguish
"the merchant has no subscription" from "we threw theirs away".

Fixtures made it invisible. Every test for the adapter and the resolver populated `authorizedAppId`,
because both were written from the same reading of the schema as the code beside them. Two units
were separately covered, both wrong in the same way, and the suite was green.

## Rules

**Never attribute a fault to an external system from our own derived telemetry.** A number produced
after our code has filtered, parsed, or defaulted something describes us, not them. Before making a
claim about an upstream service, capture what it actually sent.

**Name a measurement after what it measures.** `subscriptionCount` now means "records we could
read"; `reportedSubscriptionCount` means "records ikas returned". A gap between them is a bug in
this repository, and it is visible at a glance.

**A refusal must describe the input, not just the verdict.** `billing.entitlement.not_granted`
carries, per candidate, whether the listing id matched, whether the installation id matched, whether
it was null, and the status. That single line would have ended this in a minute.

**Freeze real payloads, not imagined ones.** `licence-adapter.test.ts` holds the exact shape a real
"Planı Yönet" purchase produces, taken from the wire. A fixture written from the schema can only
confirm what we already believe.

**Test the chain, not only the links.** `entitlement-service.test.ts` runs adapter and resolver
together against that payload. Unit tests cannot catch two components that agree with each other
and disagree with reality.

## Before sending anything to a vendor

State the evidence chain and mark which links are ours. If every link is our own code, it is not
evidence about them yet — go get the raw response first.
