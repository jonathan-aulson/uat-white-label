import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
export default defineWorkersConfig({
 test: {
  include:['test/**/*.test.ts'], setupFiles:['./test/setup.ts'],
  poolOptions:{workers:{singleWorker:true,isolatedStorage:false,wrangler:{configPath:'./wrangler.jsonc'},miniflare:{bindings:{TEST_MIGRATIONS:await readD1Migrations('./migrations'),DEPLOYMENT_ID:'test',BOOTSTRAP_ADMINS:'admin@example.com',ALLOWED_DOMAINS:'',ACCESS_TEAM_DOMAIN:'https://team.cloudflareaccess.com',ACCESS_AUD:'test-aud'}}}}
 }
});
