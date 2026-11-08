import {build} from 'esbuild';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
await mkdir('dist',{recursive:true});
await build({
  entryPoints:['src/worker-private-planner.mjs'], outfile:'dist/worker.mjs', bundle:true, format:'esm', platform:'node', target:'es2022',
  conditions:['workerd','worker','node'], external:['node:*','cloudflare:*'], minify:true, sourcemap:false, metafile:true,
  plugins:[{name:'static-files',setup(build){build.onLoad({filter:/[\\/]public[\\/].*\.(?:js|css|html)$/},async args=>({contents:await readFile(args.path,'utf8'),loader:'text'}));}}],
});
const code=await readFile('dist/worker.mjs');
await writeFile('dist/build.json',JSON.stringify({sha256:createHash('sha256').update(code).digest('hex'),bytes:code.length},null,2)+'\n');
console.log(`Built Worker (${code.length} bytes).`);
