import { defineCollection, z } from 'astro:content';
import type { Loader } from 'astro/loaders';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';

/**
 * Loader kecil untuk file .toml (loader `glob` bawaan Astro hanya mengenal md/mdx/json/yaml).
 * Satu file .toml = satu entri koleksi; id entri = nama file tanpa ekstensi.
 */
function tomlLoader(dir: string): Loader {
  return {
    name: 'toml-loader',
    load: async ({ config, store, parseData, generateDigest, watcher, logger }) => {
      const base = path.join(fileURLToPath(config.root), dir);

      const sync = async () => {
        store.clear();
        const files = (await readdir(base)).filter((f) => f.endsWith('.toml'));
        for (const file of files) {
          const id = file.replace(/\.toml$/, '');
          const raw = await readFile(path.join(base, file), 'utf-8');
          const parsed = parse(raw) as Record<string, unknown>;
          if (parsed.event_id !== id) {
            throw new Error(`${file}: field event_id ("${String(parsed.event_id)}") harus sama dengan nama file ("${id}").`);
          }
          const data = await parseData({ id, data: parsed });
          store.set({ id, data, digest: generateDigest(raw) });
        }
      };

      await sync();

      // Dev server: muat ulang saat file .toml berubah (mis. disimpan dari Sveltia CMS lokal).
      if (watcher) {
        watcher.add(base);
        const onChange = (changed: string) => {
          if (changed.startsWith(base) && changed.endsWith('.toml')) {
            sync().catch((e) => logger.error(String(e)));
          }
        };
        watcher.on('change', onChange);
        watcher.on('add', onChange);
        watcher.on('unlink', onChange);
      }
    },
  };
}

/**
 * Koleksi `rsvp`: satu file .toml = satu event.
 * Nama file = slug URL (src/content/rsvp/demo-event.toml -> /demo-event).
 * Field `event_id` WAJIB sama dengan nama file.
 */
const rsvp = defineCollection({
  loader: tomlLoader('src/content/rsvp'),
  schema: z.object({
    event_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'event_id: huruf kecil, angka, dan strip'),
    title: z.string(),
    description: z.string(),
    event_date: z.coerce.date(),
    location: z.string(),
    spreadsheet_id: z.string().min(1),
    has_assignment: z.boolean().default(false),
    theme: z
      .enum(['light', 'dark', 'cupcake', 'corporate', 'emerald', 'forest', 'synthwave', 'retro'])
      .default('light'),
    assignment_title: z.string().optional(),
    assignment_instructions: z.string().optional(),
    schedule: z
      .array(
        z.object({
          time: z.string(),
          title: z.string(),
          description: z.string().optional(),
        }),
      )
      .default([]),
  }),
});

export const collections = { rsvp };
