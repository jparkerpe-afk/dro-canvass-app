// SINGLE SOURCE OF TRUTH FOR THE DEPLOYED VERSION.
//
// Bump this on every deploy. The service worker derives its cache name from
// it, so changing this value is what makes a phone fetch new code at all —
// and the same string is displayed in the app's Version panel, so what you
// see on the phone can be compared directly against what is committed here.
//
// Format: YYYY.MM.DD-NN  (NN = deploy number that day, starting at 01)
//
// Plain script, not a module: the service worker loads it with
// importScripts() and the page loads it with a <script> tag, and `self` is
// the global in both contexts.
self.APP_VERSION = '2026.07.25-01';
