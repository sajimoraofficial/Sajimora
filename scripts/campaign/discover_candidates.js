const fs = require('fs');
const path = require('path');
const { deriveRealDiffObligations } = require('./realDiffObligationAdapter.js');
const { execSync } = require('child_process');

const repos = ['zod', 'TypeScript-Website', 'turborepo', 'express'];
const root = process.cwd();

// Previous 28 queries signatures
const prev28 = new Set([
  '2ec972ec:ToZodNormalizeEnum',
  '2ec972ec:ToZodNormalize',
  '68a609ac:_property',
  '68a609ac:_properties',
  '84dd3b0f:$ZodEnum',
  '84dd3b0f:$ZodLiteral',
  'f83ab511:_emoji',
  'a2a019a5:ToZodShape',
  'a2a019a5:toZod',
  '319f47f4:base64url',
  '319f47f4:isValidBase64URL',
  '08ba069e:isLuhnAlgo',
  '0227e53d:GitHubStarPill',
  '5d0a1d07:SidebarToggleButton',
  '5d0a1d07:Sidebar',
  '673b339a:CompilerOptionName',
  '673b339a:okToSkip',
  '673b339a:compilerOptions',
  'd21b3154:createConfigDropdown',
  '9953d5bf:getInitialCode',
  '06f59004:create',
  '06f59004:packageManager',
  'ef467721:calculateDepths',
  '4db9ca09:FetchDistTags',
  '4db9ca09:fetchDistTags',
  '4db9ca09:GET',
  '90ec6206:logerror'
]);

const discovered = [];

for (const repo of repos) {
  const repoDir = path.join(root, 'scripts/campaign/repos', repo);
  const log = execSync('git log -n 120 --pretty=format:%H --no-merges', { cwd: repoDir, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  
  for (const sha of log) {
    try {
      const parentSha = execSync(`git rev-parse ${sha}^`, { cwd: repoDir, encoding: 'utf8' }).trim();
      const subject = execSync(`git log -1 --pretty=format:%s ${sha}`, { cwd: repoDir, encoding: 'utf8' }).trim();
      const d = deriveRealDiffObligations(repoDir, parentSha, sha);
      if (d.status !== 'DERIVED') continue;
      
      for (const obl of d.obligations) {
        const sym = obl.mutatedSymbol.qualifiedName;
        const kind = obl.mutatedSymbol.kind;
        const file = obl.mutatedSymbol.declarationLocation?.filePath ?? '';
        const key = sha.slice(0, 8) + ':' + sym;
        if (prev28.has(key)) continue;
        
        discovered.push({
          repo,
          parentSha,
          candidateSha: sha,
          subject,
          symbol: sym,
          kind,
          file,
          classification: obl.providerMutation.classification,
          contract: obl.providerContracts
        });
      }
    } catch (e) {}
  }
}

console.log('Total new candidates discovered:', discovered.length);
fs.writeFileSync(path.join(root, 'scripts/campaign/candidate_pool_discovered.json'), JSON.stringify(discovered, null, 2));
