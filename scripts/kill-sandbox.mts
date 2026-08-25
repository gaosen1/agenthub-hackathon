/** 一次性脚本：kill 指定 Aone sandbox（清旧 bot 实例用；需环境提供 AONE_API_KEY） */
const { aoneDeps, AoneOrchestrator } = await import('../packages/hub-server/src/aone.js');
const sdk = await aoneDeps.loadSdk();
const o = new AoneOrchestrator(
  { apiKey: process.env.AONE_API_KEY!, image: 'x', entrypoint: 'x', timeoutSeconds: 1 },
  sdk,
);
const id = process.argv[2];
if (!id) throw new Error('usage: kill-sandbox.mts <sandboxId>');
console.log('phase before:', await o.getPodPhase(id));
await o.deleteDeployment(id);
console.log('phase after:', await o.getPodPhase(id));
