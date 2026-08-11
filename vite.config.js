import { fileURLToPath, URL } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

export default defineConfig(({ mode }) => {
  const clientBuildId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')
  const base = env.VITE_BASE_URL || '/'
  let generatedShell = []

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  return {
    plugins: [
      react(),
      {
        name: 'cloudcli-client-build-id',
        transformIndexHtml(html) {
          return html.replace('<head>', `<head>\n    <meta name="cloudcli-client-build" content="${clientBuildId}" />`)
        },
        generateBundle(_options, bundle) {
          this.emitFile({
            type: 'asset',
            fileName: 'cloudcli-version.json',
            source: JSON.stringify({ build: clientBuildId })
          })
          generatedShell = ['index.html', 'manifest.json', 'cloudcli-version.json', ...Object.keys(bundle)
            .filter((fileName) => fileName.startsWith('assets/') && /\.(?:js|css)$/.test(fileName))]
        },
        async closeBundle() {
          const workerPath = fileURLToPath(new URL('./dist/sw.js', import.meta.url))
          const source = await readFile(workerPath, 'utf8')
          await writeFile(workerPath, source
            .replace('__CLOUDCLI_BUILD_ID__', clientBuildId)
            .replace('__CLOUDCLI_SHELL__', JSON.stringify(generatedShell)))
        }
      }
    ],
    base,
    define: {
      __CLOUDCLI_CLIENT_BUILD_ID__: JSON.stringify(clientBuildId)
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/plugin-ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'codemirror-state',
                test: /node_modules[\\/]@codemirror[\\/]state[\\/]/,
                priority: 34
              },
              {
                name: 'codemirror-view',
                test: /node_modules[\\/](?:@codemirror[\\/]view|crelt|style-mod|w3c-keyname)[\\/]/,
                priority: 33
              },
              {
                name: 'codemirror-language',
                test: /node_modules[\\/](?:@codemirror[\\/]language|@lezer[\\/](?:common|highlight))[\\/]/,
                priority: 32
              },
              {
                name: 'codemirror-search',
                test: /node_modules[\\/]@codemirror[\\/]search[\\/]/,
                priority: 31
              },
              {
                name: 'codemirror-commands',
                test: /node_modules[\\/]@codemirror[\\/]commands[\\/]/,
                priority: 30
              },
              {
                name: 'syntax-highlighter',
                test: /node_modules[\\/](?:react-syntax-highlighter|highlight\.js|prismjs|refractor|lowlight|hast-util-to-text)[\\/]/,
                maxSize: 240000,
                priority: 25
              },
              {
                name: 'terminal',
                test: /node_modules[\\/]@xterm[\\/]/,
                maxSize: 240000,
                priority: 25
              },
              {
                name: 'react-router',
                test: /node_modules[\\/](?:react-router|react-router-dom)[\\/]/,
                maxSize: 240000,
                priority: 21
              },
              {
                name: 'react-dom',
                test: /node_modules[\\/]react-dom[\\/]/,
                maxSize: 240000,
                priority: 21
              },
              {
                name: 'react-core',
                test: /node_modules[\\/](?:react|scheduler)[\\/]/,
                maxSize: 240000,
                priority: 20
              },
              {
                name: 'i18n',
                test: /node_modules[\\/](?:i18next|react-i18next|i18next-browser-languagedetector)[\\/]/,
                maxSize: 240000,
                priority: 20
              }
            ]
          }
        }
      }
    }
  }
})
