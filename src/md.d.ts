// esbuild bundles .md files as text (loader: { ".md": "text" }).
declare module "*.md" {
    const content: string;
    export default content;
}
