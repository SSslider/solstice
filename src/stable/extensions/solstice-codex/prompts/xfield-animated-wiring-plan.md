# X-Field Animated Website Wiring Plan (not implemented)

This document defines the premium route boundary. It does not call X-Field, Seedance, or any paid provider.

1. The interactive build requests a short premium clip through a typed `animated/video-request` action containing the scene brief, duration, aspect ratio, provider, and estimated credits.
2. `creditRiskSignal()` must evaluate that action before autonomy or dev-autoapprove. The approval card must remain Approve-once/Deny and show the provider, intended creation, and credit estimate.
3. Only an `accept` decision from Thomas may issue one ephemeral request ID. Never persist session-wide approval and never convert `acceptForSession` into permission for this action.
4. A future provider bridge exchanges the approved request ID for one job, polls with a bounded timeout, downloads the clip into `.solstice/animated/approved/`, and records provider/job metadata without credentials.
5. The bridge then runs `animated-assets.js from-video <workspace> <clip> --thomas-approved`. This local step only extracts WebP frames and writes the scrub manifest; it does not generate or spend credits.
6. Failed, canceled, or expired jobs stop. They never fall back to another paid provider and never retry a billable request without a new approval card.

Implementation gate: Orion and Thomas must approve the provider/bridge contract, credential location, estimate source, cancellation behavior, and one-job approval token before any provider call is added.
