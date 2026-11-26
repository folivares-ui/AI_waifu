import type { ServerMessage } from "@waifu/core";

type Req = Extract<ServerMessage, { type: "approval_request" }>;

/**
 * Shown when she wants to change something (save a file, click, type, run a script). Nothing happens until the
 * user presses "Permitir". There is deliberately no keyboard default, so a stray Enter cannot approve.
 */
export function ApprovalCard({ req, name, onAnswer }: { req: Req; name: string; onAnswer: (approved: boolean, giveControl?: boolean) => void }) {
  return (
    <section className="approval" role="alertdialog" aria-labelledby={`ap-${req.id}`} aria-describedby={`apd-${req.id}`}>
      <p id={`ap-${req.id}`} className="approval-title">
        <span aria-hidden="true">⚠</span> {name} quiere: <strong>{req.summary}</strong>
      </p>
      {req.details && (
        <pre id={`apd-${req.id}`} className="approval-details">
          {req.details}
        </pre>
      )}
      {req.preview && <img className="approval-preview" alt="Vista previa de la accion" src={`data:${req.preview.mime};base64,${req.preview.data}`} />}
      <div className="approval-buttons">
        <button type="button" className="deny" onClick={() => onAnswer(false)}>
          No
        </button>
        <button type="button" className="allow" onClick={() => onAnswer(true)}>
          Permitir
        </button>
      </div>
      {req.controllable && (
        <button
          type="button"
          className="give-control"
          title="Permite esta accion y las siguientes (clics, texto, teclas) sin preguntarte, hasta que termine lo que le pediste. Borrar, cerrar o enviar seguira preguntando. Puedes quitarselo cuando quieras."
          onClick={() => onAnswer(true, true)}
        >
          Darle el control hasta que termine
        </button>
      )}
      <p className="approval-tool">Herramienta: {req.tool}</p>
    </section>
  );
}
