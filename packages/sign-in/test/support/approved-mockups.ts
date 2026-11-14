/** The approved first-journey mockups (docs/mockups/first-journey), read as the expected markup of each scene. */
import { readFileSync } from 'node:fs';

import { z } from 'zod';

const gallery = readFileSync(new URL('../../../../docs/mockups/first-journey/index.html', import.meta.url), 'utf8');
const start = gallery.indexOf('[{"id": "01-');
const scenes = z.array(z.object({ id: z.string(), after: z.string() })).parse(JSON.parse(gallery.slice(start, gallery.indexOf('}];', start) + 2)));

/** The approved after-page of a scene, such as `05-too-many-attempts`. */
export function approvedScene(id: string): string {
  const scene = scenes.find((candidate) => candidate.id === id);
  if (scene === undefined) throw new Error(`No approved scene ${id}`);
  return scene.after;
}

/** The approved notice of a scene: its tone, icon and lines. */
export function approvedNotice(id: string): string {
  return noticeIn(approvedScene(id));
}

/** The notice in rendered markup, without the live-region role the approved static mockup has no need for. */
export function noticeIn(markup: string): string {
  return (/<div class="notice [^"]*"[^>]*>[\s\S]*?<\/div><\/div>/.exec(markup)?.[0] ?? '').replace(' role="alert"', '');
}

/** The approved terminal output of a setup scene, after the command line. */
export function approvedOutput(id: string): string[] {
  const output = /<pre>([\s\S]*?)<\/pre>/.exec(approvedScene(id))?.[1] ?? '';
  return output.split('\n').slice(1);
}
