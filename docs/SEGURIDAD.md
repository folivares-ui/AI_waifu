# Seguridad de Rice Shower (AI Waifu)

Resumen de cómo se protege el programa y qué conviene que hagas tú. Revisado el 2026-11-18.

## Qué protege el programa

**Conexiones**
- El servidor solo escucha en tu PC (`127.0.0.1`). Para usarlo desde el móvil hay que poner `HOST=0.0.0.0` **y** un `AUTH_TOKEN` largo; sin token se niega a arrancar.
- Sin token, solo acepta peticiones dirigidas a `localhost`/`127.0.0.1` y desde la propia app: otras páginas web no pueden hablar con Rice ni leer su memoria, ni siquiera con el truco de "DNS rebinding".
- El token se compara en tiempo constante.
- El control del ratón/teclado de la app de escritorio escucha solo en tu PC y exige una clave aleatoria nueva en cada arranque.
- La ventana de escritorio no tiene permisos especiales de Tauri.

**Acciones**
- Todo lo que cambia algo (guardar o editar archivos, clics, escribir, ejecutar scripts, dar acceso a otra carpeta) muestra una tarjeta y **solo se hace si pulsas Permitir**. Sin respuesta en 2 minutos = no.
- Cada acción pedida queda registrada en `data/actions.jsonl`.
- Antes de modificar un archivo se guarda una copia en `data/backups`.
- Solo trabaja en las carpetas de `WORKSPACE_DIRS`. Las carpetas del sistema, de programas, `AppData`, `.ssh`, discos enteros y tu carpeta de usuario completa están prohibidas siempre.
- Los permisos para otras carpetas se olvidan al cerrar la app. Cuando no hay ninguna ventana abierta, no actúa sobre otros programas.
- No abre ejecutables, scripts ni accesos directos (`.exe`, `.bat`, `.ps1`, `.vbs`, `.lnk`, `.msi`...). El código se abre en VS Code, como texto.
- Blender se abre con `--disable-autoexec`: los scripts escondidos en un `.blend` no se ejecutan.
- Su navegador usa un perfil separado: no ve tu historial, contraseñas ni sesiones. Nunca rellena campos de contraseña o de pago. No entra en direcciones de tu red local.

**Instrucciones escondidas ("prompt injection")**
- Lo que lee en documentos, páginas y pantallas se marca como datos, no como órdenes.
- Además: en cuanto ha leído algo en una respuesta, **abrir una página o consultar una API también pide tu aprobación**, mostrando la dirección completa. Así un documento o una web maliciosa no puede sacar tus datos dentro de una URL. Si ves una dirección rara (con texto tuyo, números, códigos), pulsa **No**.

**Privacidad**
- El micrófono y la cámara solo se encienden con sus botones. Los gestos se analizan en tu PC.
- Lo que ve en la pantalla no se guarda en su memoria.
- Tus datos (`.env`, memoria, registro, copias, perfil del navegador, clips de voz) están excluidos de Git: no se suben a GitHub.
- El instalador no incluye tu `.env` ni tus datos.

**Descargas**
- Node.js para el instalador se verifica contra la firma SHA-256 publicada por nodejs.org.
- El modelo de gestos se verifica con su SHA-256.
- Las librerías de npm se verifican con el `package-lock.json`. A fecha de esta revisión, `npm audit` no reporta vulnerabilidades (se forzaron versiones corregidas de `uuid` e `image-size`).

## Límites (lo que no puede garantizar)

- Si apruebas una acción, se hace. **Lee las tarjetas**, sobre todo los scripts de Blender y los clics en el escritorio: un script puede hacer cualquier cosa en tu equipo.
- El modelo de IA puede equivocarse o dejarse engañar; las tarjetas son la red de seguridad.
- Lo que escribes y lo que ella lee se envía a Claude (Anthropic) si usas ese cerebro. Con Ollama todo queda en tu PC.
- La memoria (`data/memory.json`) y tu `.env` se guardan sin cifrar en tu disco: cualquiera con acceso a tu usuario de Windows puede leerlos.
- El instalador no está firmado digitalmente: Windows SmartScreen mostrará un aviso ("Windows protegió tu PC"). Es normal para programas propios; pulsa "Más información" → "Ejecutar de todas formas" solo con el instalador que **tú** compilaste.

## Lo que conviene que hagas

1. **Claves**: nunca las pegues en chats, capturas ni archivos que subas. Si se filtra una, revócala en console.anthropic.com y crea otra. Pon un límite de gasto mensual en la consola de Anthropic.
2. **Windows al día** y **Microsoft Defender** activado (incluida la "Protección contra ransomware / acceso controlado a carpetas" si quieres más protección para Documentos).
3. **No uses `npm audit fix --force`**: puede romper la app. Si `npm audit` muestra algo nuevo, pregunta antes.
4. **Instala solo desde fuentes oficiales**: Node.js (nodejs.org), Ollama (ollama.com), Rust (rustup), VS Code, Blender, VoiceStudio (su GitHub). Desconfía de "versiones modificadas".
5. **Modo móvil**: usa un `AUTH_TOKEN` largo y aleatorio, HTTPS, y no abras el puerto al internet público (usa tu Wi-Fi o una VPN como Tailscale).
6. **Carpeta de trabajo**: dale a `WORKSPACE_DIRS` solo las carpetas que necesite, no todo Documentos.
7. **Copias de seguridad** de tus archivos importantes, independientes de la app.
8. Revisa de vez en cuando `data/actions.jsonl` para ver qué acciones se pidieron.
