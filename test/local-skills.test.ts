import { describe,it,expect } from 'vitest';
import { classifyVaultSkills, resolveAttribution, localUpdateHandoff } from '../src/local-integration';
import { defaultState } from '../src/state';
import { scanDocuments } from '../src/learning';
const content='---\nname: export\ndescription: Export files\n---\nCheck destination.';
const skill={id:'local',name:'export',path:'/vault/Skills/export/SKILL.md',hash:'a'.repeat(64),content};
describe('authored local skill integration',()=>{
 it('recognizes default and custom authored packages and excludes package resources from evidence',async()=>{
  const state=defaultState();state.skills=classifyVaultSkills([skill],'/vault','Skills');
  expect(state.skills[0]?.localSkillId).toBe('export');
  expect(classifyVaultSkills([{...skill,path:'/vault/Guidance/export/SKILL.md'}],'/vault','Guidance')[0]?.localSkillId).toBe('export');
  await scanDocuments(state,[{path:'Skills/export/references/failures.md',size:50},{path:'Activity.md',size:50}],async()=> 'local:export timeout failed');
  expect(state.evidence).toHaveLength(1);expect(state.evidence[0]?.sourcePath).toBe('Activity.md');
 });
 it('resolves qualified local names without selecting an ambiguous bare name',()=>{
  const local=classifyVaultSkills([skill],'/vault','Skills')[0]!;
  const external={...skill,id:'external',path:'/other/export/SKILL.md'};
  expect(resolveAttribution('local:export',[local,external])?.id).toBe('local');
  expect(resolveAttribution('export',[local,external])).toBeUndefined();
 });
 it('exports only SKILL.md for eligible approved local changes, preserving omitted resources',()=>{
  const local=classifyVaultSkills([skill],'/vault','Skills')[0]!;
  const candidate={id:'c',skill:local.id,content,sourceHash:local.hash,status:'approved' as const,createdAt:'now'};
  expect(localUpdateHandoff(candidate,local)).toEqual({skillId:'export',files:[{path:'SKILL.md',encoding:'utf8',content}]});
  expect(localUpdateHandoff({...candidate,content:'# No manifest'},local)).toBeUndefined();
  expect(localUpdateHandoff(candidate,skill)).toBeUndefined();
 });
});
