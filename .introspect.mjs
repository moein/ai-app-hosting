import { readEnvFile } from './scripts/env-file.mjs';
const t = readEnvFile('dev').CF_API_TOKEN;
const q = async (query) => (await (await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: JSON.stringify({ query }) })).json());
const T = 'type { name ofType { name ofType { name ofType { name ofType { name } } } } }';
const unwrap = (ty) => { while (ty && !ty.name) ty = ty.ofType; return ty?.name; };
const fields = async (type) => (await q(`{ __type(name:"${type}") { fields { name ${T} } } }`)).data.__type?.fields ?? [];
const acct = await fields('account');
for (const ds of process.argv.slice(2)) {
  const f = acct.find((x) => x.name === ds);
  const tn = unwrap(f.type);
  console.log('==', ds, tn);
  for (const g of await fields(tn)) {
    if (['sum', 'dimensions', 'max', 'quantiles', 'avg', 'min'].includes(g.name)) {
      console.log(`  ${g.name}: ${(await fields(unwrap(g.type))).map((s) => s.name).join(', ')}`);
    }
  }
}
