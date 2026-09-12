import { dirname, relative, resolve, isAbsolute, sep } from 'node:path';
import type { InstalledSkill } from './learning';
import type { Candidate } from './model';

export function validAuthoredFolder(folder:string):boolean {
  return !!folder && !isAbsolute(folder) && !/[\\:\x00-\x1f]/.test(folder) && folder.split('/').every(p=>!!p&&!p.startsWith('.')&&!/[. ]$/.test(p));
}
export function classifyVaultSkills(skills:InstalledSkill[],vault:string,folder:string):InstalledSkill[] {
  const root=resolve(vault,folder);
  return skills.map(skill=>{
    const packagePath=relative(vault,dirname(skill.path));
    const vaultPackagePath=packagePath&&!packagePath.startsWith('..')&&!isAbsolute(packagePath)?packagePath.split(sep).join('/'):undefined;
    const localPath=relative(root,skill.path).split(sep).join('/');
    const match=/^([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/.exec(localPath);
    const slug=match?.[1];
    return {...skill,vaultPackagePath,localSkillId:validAuthoredFolder(folder)&&slug&&slug.length<=64&&validManifest(skill.content,slug)?slug:undefined};
  });
}
export function resolveAttribution(name:string,skills:InstalledSkill[]):InstalledSkill|undefined {
  const matches=skills.filter(s=>s.id===name || (name.startsWith('local:')?s.localSkillId===name.slice(6):s.name===name));
  return matches.length===1?matches[0]:undefined;
}
export function localUpdateHandoff(candidate:Candidate,skill:InstalledSkill|undefined):{skillId:string;files:Array<{path:string;encoding:'utf8';content:string}>}|undefined {
  if(!skill?.localSkillId || candidate.status!=='approved'||candidate.sourceHash!==skill.hash||!validManifest(candidate.content,skill.localSkillId)) return undefined;
  return {skillId:skill.localSkillId,files:[{path:'SKILL.md',encoding:'utf8',content:candidate.content}]};
}
// Conservative simple YAML subset; complex manifests remain ordinary review packets.
function validManifest(content:string,slug:string):boolean {
  const front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  if(!front) return false;
  const field=(name:string)=>front.match(new RegExp('^'+name+':\\s*["\']?([^\\n"\']+)','m'))?.[1]?.trim();
  return field('name')===slug && !!field('description') && !['|','>','null','~'].includes(field('description')!);
}
