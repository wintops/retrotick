import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { analyzer } from 'vite-bundle-analyzer';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
	plugins: [
		preact(),
		tailwindcss(),
		...(process.env.VITE_ENABLE_ANALYZER === '1' ? [analyzer()] : []),
		//viteSingleFile(),
	],
build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        entryFileNames: '[name].js',

        assetFileNames: '[name].[ext]', 


    
      },
    },
  },
});
