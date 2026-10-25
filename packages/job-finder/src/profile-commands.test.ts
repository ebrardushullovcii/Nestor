import {afterEach,expect,test} from 'vitest';
import {CandidateExperienceSchema} from '@nestor/contracts';
import {openJobStore,createProfileStore,type JobStore} from '@nestor/db/job-store';
import {createJobCommandRunner} from './job-commands';
const stores:JobStore[]=[];afterEach(()=>{for(const store of stores.splice(0))store.close();});
function setup(){const store=openJobStore(':memory:');stores.push(store);return {store,run:createJobCommandRunner({store})};}

test('a Profile save commits edited fields and one record together; an invalid goals edit rolls everything back',async()=>{
 const {store,run}=setup();
 await run('commit_profile_edits',{profile:{fields:{headline:'Analyst'}},upsert:[{collection:'experiences',record:CandidateExperienceSchema.parse({id:'work',title:'Analyst',companyName:'Synthetic Lab',workMode:[]})}]});
 expect((await run('get_profile',{})).counts.experiences).toBe(1);
 await run('patch_profile_goals',{fields:{'compensation.minimum':20,'compensation.maximum':30}});
 await expect(run('commit_profile_edits',{profile:{fields:{headline:'Should not save'}},goals:{fields:{'compensation.maximum':10}},remove:[{collection:'experiences',id:'work'}]})).rejects.toThrow();
 expect((await run('get_profile',{})).fields.headline).toBe('Analyst');
 expect(createProfileStore(store).records.get('experiences','work')).not.toBeNull();
});

test('the four resume levels persist together with the correct writing mode',async()=>{
 const {run}=setup();
 for(const approach of ['original_resume','conservative','balanced','aggressive'] as const){
  await run('set_resume_approach',{approach});
  const settings=await run('get_settings',{}),goals=await run('get_profile_goals',{});
  expect(settings.resumeApplicationMode).toBe(approach==='original_resume'?'original_resume':'tailored_per_job');
  if(approach!=='original_resume')expect(goals.tailoringMode).toBe(approach);
 }
});
