# Sort the catalog by price

Type: build
Touches: sf-list-products

## Context

`listProducts` returns the catalog unordered.

## Task

Add a `sort=price` query parameter.

## Verify

1. `GET /api/products?sort=price` returns ascending by price.
2. No parameter keeps today's order.
