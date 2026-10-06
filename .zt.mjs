import { z } from "zod";

const cases = {
  "enum.optional().default": z.object({
    i: z.enum(["a", "b"]).optional().default("a"),
  }),
  "object.superRefine": z
    .object({ a: z.number() })
    .superRefine((v, c) => {
      if (v.a < 0) c.addIssue({ code: "custom", message: "x" });
    }),
  "array.max.refine": z.object({
    r: z
      .array(z.string())
      .max(5)
      .refine((x) => x.length === new Set(x).size),
  }),
  "string.datetime.nullable": z.object({ d: z.string().datetime().nullable() }),
  "literal number": z.object({ p: z.literal(500) }),
  "nested superRefined object": z.object({
    x: z.object({ a: z.number() }).superRefine(() => {}),
  }),
  "object.extend after superRefine-member": z
    .object({ x: z.object({ a: z.number() }).superRefine(() => {}) })
    .extend({ y: z.string() }),
};

for (const [name, schema] of Object.entries(cases)) {
  try {
    z.toJSONSchema(schema);
    console.log("OK    ", name);
  } catch (e) {
    console.log("THROW ", name, "->", e.message);
  }
}
