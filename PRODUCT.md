# Folio

<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
React and Node.js. Hosted on Railway with Railpack; no user-managed Docker. The user specified Railway and no Docker after being offered a stack recommendation.

## Users
Public users who need a simple tool with a clean, light interface.

## Product Purpose
Convert a single file or a folder of files into selected output formats, then download the results.

## Capabilities and Constraints
File selection, folder selection, batch conversion, compatible output choices, individual downloads and a folder-preserving ZIP download. The backend must be extensible across file categories. Arbitrary all-to-all conversion is impossible; expose actual engine capabilities. Railway runs the native conversion engines installed through Railpack.

The user requested ZDR, interpreted as zero data retention: temporary processing files only, no database, no file history or third-party file processing. Delete after download, explicit discard, abandonment expiry, and graceful shutdown. This application-level policy is not a certification of the hosting provider's underlying storage.

## Brand Commitments
Clean, light interface. Folio is a provisional product name selected for the implementation.

## Product Principles
Show compatible formats rather than promise impossible conversions. Make file lifecycle and errors clear. Keep conversion local to the service. Avoid mandatory accounts.
