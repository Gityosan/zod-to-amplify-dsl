// Full-feature showcase. Each model is intentionally small but together they
// exercise every code path the converter handles:
//
//   Product     — scalar types, validation, default, optional, customType
//   Address     — non-model nested object → emitted as a.customType()
//   Order       — composite primary key, scalar enum array, belongsTo
//   Membership  — groups-based auth with explicit operations
//   Audit       — z.any() (intentional JSON), z.literal(), z.union() of literals
//   Profile     — hasOne (no FK on this side)
//   Event       — ISO date/time (z.iso.date / z.iso.time) and v4 wrappers
//                 (readonly, nonoptional, prefault, exactOptional)

import { z } from "zod"
import { defineModel } from "../src/index.js"

// Non-model nested object — referenced by Product.address.
// Converter automatically emits this as `a.customType()`.
const Address = z.object({
  street: z.string(),
  city: z.string(),
  postalCode: z.string(),
  country: z.string().default("JP"),
})

export const Product: z.ZodObject<any> = defineModel(
  z.object({
    id: z.uuid(),
    sku: z.string(),
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    price: z.number().min(0),
    stock: z.number().int().default(0),
    isPublished: z.boolean().default(false),
    rating: z.number().min(0).max(5).optional(),
    homepage: z.url().optional(),
    contactEmail: z.email().optional(),
    contactPhone: z.string().optional(), // free-form phone
    releasedAt: z.iso.datetime().optional(),
    discontinuedAt: z.iso.datetime().nullable(),
    address: Address, // → a.customType("Address")
    tags: z.array(z.string()),
    categories: z.array(z.enum(["food", "electronics", "books", "clothing"])),
  }),
  {
    indexes: [
      { name: "bySku", pk: "sku" },
      { name: "byPublished", pk: "isPublished", sk: "releasedAt" },
    ],
    auth: [
      { allow: "owner" },
      { allow: "public", operations: ["read"] },
    ],
  }
)

// Composite primary key + belongsTo Product.
export const Order: z.ZodObject<any> = defineModel(
  z.object({
    tenantId: z.string(),
    orderId: z.uuid(),
    productId: z.string(),
    quantity: z.number().int().min(1),
    total: z.number().min(0),
    status: z.enum(["pending", "paid", "shipped", "delivered", "cancelled"]).default("pending"),
    createdAt: z.iso.datetime(),

    // belongsTo Product via productId
    get product(): z.ZodObject<any> {
      return Product
    },
  }),
  {
    primaryKey: ["tenantId", "orderId"],
    indexes: [{ name: "byProduct", pk: "productId", sk: "createdAt" }],
    auth: [
      { allow: "groups", groups: ["admin"] },
      { allow: "groups", groups: ["staff"], operations: ["read"] },
    ],
  }
)

// Groups-based auth with operation-level restrictions.
export const Membership: z.ZodObject<any> = defineModel(
  z.object({
    id: z.uuid(),
    userId: z.string(),
    plan: z.enum(["free", "pro", "enterprise"]).default("free"),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime().optional(),
    autoRenew: z.boolean().default(true),
  }),
  {
    auth: [
      { allow: "owner", ownerField: "userId" },
      { allow: "groups", groups: ["admin"], operations: ["create", "update", "delete"] },
      { allow: "groups", groups: ["billing"], operations: ["read"] },
    ],
  }
)

// z.any(), z.literal(), z.union() of literals — converter handles these
// without warnings (any/unknown are intentional; literals/unions are hoisted
// into a schema-level a.enum()).
export const Audit: z.ZodObject<any> = defineModel(
  z.object({
    id: z.uuid(),
    level: z.literal("info"), // hoisted: a.ref("Level"), Level: a.enum(["info"])
    severity: z.union([z.literal("low"), z.literal("medium"), z.literal("high")]),
    actor: z.string(),
    payload: z.any(), // → a.json(), no warning
    occurredAt: z.iso.datetime(),
  }),
  {
    indexes: [{ name: "byActor", pk: "actor", sk: "occurredAt" }],
    auth: [{ allow: "groups", groups: ["admin"], operations: ["read"] }],
  }
)

// hasOne — no FK on this side, so Profile gets a.hasOne("User", "userId")
// Inverse side (User.profile) lives in this same example for symmetry.
export const Profile: z.ZodObject<any> = defineModel(
  z.object({
    id: z.uuid(),
    userId: z.string(),
    displayName: z.string(),
    avatarUrl: z.url().optional(),
    timezone: z.string().default("UTC"),
  }),
  {
    auth: [{ allow: "owner", ownerField: "userId" }],
  }
)

export const User: z.ZodObject<any> = defineModel(
  z.object({
    id: z.uuid(),
    email: z.email(),
    name: z.string(),
    // hasOne Profile — no FK column here, so converter emits a.hasOne()
    get profile(): z.ZodObject<any> {
      return Profile
    },
  }),
  {
    auth: [
      { allow: "owner" },
      { allow: "public", operations: ["read"] },
    ],
  }
)

// Zod v4 single-type formats + wrapper classes.
// ISO date/time → Amplify a.date() / a.time()
// readonly / nonoptional / prefault / exactOptional → unwrapped transparently
export const Event: z.ZodObject<any> = defineModel(
  z.object({
    id: z.uuid(),
    title: z.string().readonly(),                  // ZodReadonly → a.string().required()
    organizerId: z.string().nonoptional(),         // ZodNonOptional → a.id().required()
    eventDate: z.iso.date(),                       // ZodISODate → a.date()
    startTime: z.iso.time(),                       // ZodISOTime → a.time()
    endTime: z.iso.time().optional(),              // optional ISO time → a.time()
    visibility: z.prefault(z.enum(["public", "private", "unlisted"]), "public"),
    notes: z.exactOptional(z.string()),            // ZodExactOptional → a.string()
    capacity: z.number().int().min(0).default(100),
  }),
  {
    indexes: [{ name: "byDate", pk: "eventDate", sk: "startTime" }],
    auth: [
      { allow: "owner", ownerField: "organizerId" },
      { allow: "public", operations: ["read"] },
    ],
  }
)
