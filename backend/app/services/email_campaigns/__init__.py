"""Email campaigns: compose with merge tags, preview as a real recipient, test,
send in throttled Resend batches from a restart-safe background worker, and
track deliveries, opens, clicks and unsubscribes.

Modules: ``tags`` (merge-tag language), ``render`` (the one renderer), ``links``
(tracking URLs + click allow-list), ``templates``, ``audience`` (segments and
exclusions), ``senders``, ``transport`` (Resend / console), ``store`` (Mongo),
``engine`` (queue, ticks, controls, worker), ``webhooks`` (Resend events).
Routes: ``routers/admin_email.py`` (admin) and ``routers/email_public.py``
(pixel, click, unsubscribe, webhook).
"""
