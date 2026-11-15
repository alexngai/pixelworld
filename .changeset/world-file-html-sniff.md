---
"pixelworld": patch
---

A world file without a content type is taken for an HTML page only when it starts with an opening tag (`<!doctype`, `<html`, `<head`, `<body`, `<!--`), not any `<`: a `.gz` a server sends with `Content-Encoding: gzip` (Vite's dev server) arrives decompressed, and binary data such as a geo grid may start with that byte.
