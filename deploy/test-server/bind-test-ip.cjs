// Execute only against the isolated test database, after HTTPS IP ownership has
// been verified. Uses the compiled API; no server compilation or dependency install.
const { createRequire } = require('node:module');
const req = createRequire('/opt/nightflix/current/apps/api/package.json');
const { DatabaseService } = req('./dist/database/database.service');
const { uuidV7 } = req('./dist/common/uuid-v7');
const { randomBytes } = require('node:crypto');
const db = new DatabaseService();
(async () => {
  await db.validateProductionSecurity();
  await db.inPlatformContext(async sql => {
    const [tenant] = await sql`select id from tenants where code='demo' for update`;
    const [actor] = await sql`select id from platform_staff where username='nightflix_admin'`;
    if (!tenant || !actor) throw new Error('Expected isolated test tenant/admin missing');
    const [existing] = await sql`select tenant_id from tenant_domains where host='47.110.245.29'`;
    if (existing) {
      if (existing.tenant_id !== tenant.id) throw new Error('IP belongs to another tenant');
      console.log('Test IP already bound; unchanged'); return;
    }
    const id=uuidV7();
    await sql`insert into tenant_domains(id,tenant_id,host,type,verification_token,verified_at,tls_status,is_primary,created_by)
      values(${id},${tenant.id},'47.110.245.29','custom',${randomBytes(24).toString('base64url')},statement_timestamp(),'active',false,${actor.id})`;
    await sql`insert into audit_logs(id,scope_type,tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_json,request_id)
      values(${uuidV7()},'platform',${tenant.id},'platform_staff',${actor.id},'test.domain.bind_ip','tenant_domain',${id},${sql.json({host:'47.110.245.29',verification:'ACME IP HTTPS ownership',testOnly:true})},${uuidV7()})`;
    console.log('Verified test IP bound to demo tenant with audit record');
  });
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>db.onApplicationShutdown());
