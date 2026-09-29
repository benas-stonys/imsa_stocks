const {test}=require('node:test');const assert=require('node:assert/strict');
const {createAuditHandler}=require('../netlify/functions/student-audit');
const event={httpMethod:'GET',headers:{authorization:'Bearer test'},queryStringParameters:{}};
test('audit denies anonymous and student access before reading transactions',async()=>{
 let calls=0;const handler=createAuditHandler(()=>({auth:{getUser:async()=>({data:{user:{id:'s'}}})},from:table=>{calls++;assert.equal(table,'profiles');return {select:()=>({eq:()=>({single:async()=>({data:{role:'student'}})})})}}}));
 assert.equal((await handler({...event,headers:{}})).statusCode,401);
 assert.equal(calls,0);assert.equal((await handler(event)).statusCode,403);assert.equal(calls,1);
});
test('admin audit includes new students without trades and paginates verified transactions',async()=>{
 const student='12345678-1234-1234-1234-123456789abc';let range;
 const handler=createAuditHandler(()=>({auth:{getUser:async()=>({data:{user:{id:'admin'}}})},from:table=>{
  const q={select:()=>q,eq:()=>q,single:async()=>({data:{role:'admin'}}),order:()=> table==='profiles'?Promise.resolve({data:[{id:student,username:'New student'}]}):q,range:(a,b)=>{range=[a,b];return Promise.resolve({data:[],count:0});}};return q;
 }}));
 const result=await handler({...event,queryStringParameters:{student,page:'1'}});assert.equal(result.statusCode,200);assert.deepEqual(range,[50,99]);assert.equal(JSON.parse(result.body).students[0].username,'New student');
});
