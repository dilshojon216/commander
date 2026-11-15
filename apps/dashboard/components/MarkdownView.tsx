import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Xavfsiz markdown: raw HTML ishlatilmaydi (rehype-raw yo'q), URL'lar react-markdown'ning
 * default urlTransform'idan o'tadi, rasmlar yuklanmaydi (alt matn ko'rsatiladi),
 * checkbox'lar faqat o'qish uchun (disabled).
 */
export function MarkdownView({ content, className = "px-4 py-3" }: { content: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
          img: ({ alt }) => <span className="text-mu">[rasm: {alt || "nomsiz"}]</span>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
