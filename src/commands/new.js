import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../errors.js';
import { checkId, renderTicketTemplate, ticketPaths } from '../ticket.js';

// proven new T-N "<title>" [--url <start url>] [--landmark <text>]
export async function cmdNew({ root, out }, [id, title], flags) {
  checkId(id);
  if (!title || !String(title).trim()) throw new Refusal(`Give ${id} a title: proven new ${id} "Coupon SAVE10 takes 10% off"`);
  if (/[\r\n]/.test(title)) throw new Refusal('The title must be one line.');
  const p = ticketPaths(id);
  const file = join(root, p.ticket);
  if (existsSync(file)) throw new Refusal(`${p.ticket} already exists.`);
  mkdirSync(join(root, 'tickets'), { recursive: true });
  writeFileSync(file, renderTicketTemplate({ id, title: title.trim(), url: flags.url ?? '', landmark: flags.landmark ?? '' }));
  const todo = [!flags.url && 'the start URL', !flags.landmark && 'the landmark', 'the acceptance criteria'].filter(Boolean);
  out.say(`Created ${p.ticket}.`);
  out.say(`Fill in ${todo.join(', ').replace(/, ([^,]*)$/, ' and $1')}. Each criterion ends in a Verify line.`);
  out.say(`Then run: proven freeze ${id}`);
  return 0;
}
