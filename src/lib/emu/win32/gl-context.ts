// OpenGL 1.x fixed-function pipeline emulation via WebGL2

// GL constants
const GL_POINTS = 0x0000, GL_LINES = 0x0001, GL_LINE_STRIP = 0x0003;
const GL_TRIANGLES = 0x0004, GL_TRIANGLE_STRIP = 0x0005, GL_TRIANGLE_FAN = 0x0006;
const GL_QUADS = 0x0007, GL_QUAD_STRIP = 0x0008, GL_POLYGON = 0x0009;

const GL_DEPTH_TEST = 0x0B71, GL_CULL_FACE = 0x0B44, GL_BLEND = 0x0BE2;
const GL_LIGHTING = 0x0B50, GL_LIGHT0 = 0x4000, GL_LIGHT1 = 0x4001;
const GL_TEXTURE_2D = 0x0DE1, GL_SCISSOR_TEST = 0x0C11;
const GL_NORMALIZE = 0x0BA1, GL_COLOR_MATERIAL = 0x0B57;
const GL_AUTO_NORMAL = 0x0D80;
const GL_MAP2_VERTEX_3 = 0x0DB7, GL_MAP2_VERTEX_4 = 0x0DB8, GL_MAP2_NORMAL = 0x0DB2;

const GL_MODELVIEW = 0x1700, GL_PROJECTION = 0x1701;

const GL_AMBIENT = 0x1200, GL_DIFFUSE = 0x1201, GL_SPECULAR = 0x1202;
const GL_POSITION = 0x1203, GL_AMBIENT_AND_DIFFUSE = 0x1602;
const GL_LIGHT_MODEL_AMBIENT = 0x0B53, GL_LIGHT_MODEL_TWO_SIDE = 0x0B52;

const GL_FRONT = 0x0404, GL_BACK = 0x0405, GL_FRONT_AND_BACK = 0x0408;
const GL_CW = 0x0900, GL_CCW = 0x0901;

const GL_COLOR_BUFFER_BIT = 0x4000, GL_DEPTH_BUFFER_BIT = 0x100;

const GL_TEXTURE_MAG_FILTER = 0x2800, GL_TEXTURE_MIN_FILTER = 0x2801;
const GL_TEXTURE_WRAP_S = 0x2802, GL_TEXTURE_WRAP_T = 0x2803;
const GL_NEAREST = 0x2600, GL_LINEAR = 0x2601;
const GL_NEAREST_MIPMAP_NEAREST = 0x2700, GL_LINEAR_MIPMAP_NEAREST = 0x2701;
const GL_NEAREST_MIPMAP_LINEAR = 0x2702, GL_LINEAR_MIPMAP_LINEAR = 0x2703;
const GL_REPEAT = 0x2901, GL_CLAMP = 0x2900;
const GL_CLAMP_TO_EDGE = 0x812F;

const GL_RGBA = 0x1908, GL_RGB = 0x1907, GL_LUMINANCE = 0x1909;
const GL_LUMINANCE_ALPHA = 0x190A, GL_ALPHA = 0x1906;
const GL_UNSIGNED_BYTE = 0x1401;

const GL_COMPILE = 0x1300, GL_COMPILE_AND_EXECUTE = 0x1301;

const GL_FLAT = 0x1D00, GL_SMOOTH = 0x1D01;

const GL_FILL = 0x1B02;

const GL_SRC_ALPHA = 0x0302, GL_ONE_MINUS_SRC_ALPHA = 0x0303;

const GL_VERTEX_ARRAY = 0x8074, GL_NORMAL_ARRAY = 0x8075;
const GL_COLOR_ARRAY = 0x8076, GL_TEXTURE_COORD_ARRAY = 0x8078;
const GL_FLOAT = 0x1406;
const GL_UNSIGNED_SHORT = 0x1403, GL_UNSIGNED_INT = 0x1405;

const GL_VENDOR = 0x1F00, GL_RENDERER = 0x1F01, GL_VERSION = 0x1F02, GL_EXTENSIONS = 0x1F03;
const GL_MAX_TEXTURE_SIZE = 0x0D33, GL_MAX_LIGHTS = 0x0D31;

const GL_TEXTURE_ENV = 0x2300, GL_TEXTURE_ENV_MODE = 0x2200;
const GL_MODULATE = 0x2100, GL_DECAL = 0x2101, GL_REPLACE = 0x1E01;

// Matrix helpers (column-major 4x4)
function mat4Identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const r = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      r[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
    }
  }
  return r;
}

function mat4Translate(m: Float32Array, x: number, y: number, z: number): Float32Array {
  const t = mat4Identity();
  t[12] = x; t[13] = y; t[14] = z;
  return mat4Multiply(m, t);
}

function mat4Scale(m: Float32Array, x: number, y: number, z: number): Float32Array {
  const s = mat4Identity();
  s[0] = x; s[5] = y; s[10] = z;
  return mat4Multiply(m, s);
}

function mat4Rotate(m: Float32Array, angleDeg: number, ax: number, ay: number, az: number): Float32Array {
  const len = Math.sqrt(ax * ax + ay * ay + az * az);
  if (len < 1e-10) return m;
  ax /= len; ay /= len; az /= len;
  const rad = angleDeg * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad), t = 1 - c;
  const r = mat4Identity();
  r[0] = t * ax * ax + c;      r[4] = t * ax * ay - s * az;  r[8]  = t * ax * az + s * ay;
  r[1] = t * ax * ay + s * az; r[5] = t * ay * ay + c;       r[9]  = t * ay * az - s * ax;
  r[2] = t * ax * az - s * ay; r[6] = t * ay * az + s * ax;  r[10] = t * az * az + c;
  return mat4Multiply(m, r);
}

function mat4Perspective(fovDeg: number, aspect: number, zNear: number, zFar: number): Float32Array {
  const f = 1.0 / Math.tan(fovDeg * Math.PI / 360);
  const nf = 1 / (zNear - zFar);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (zFar + zNear) * nf;
  m[11] = -1;
  m[14] = 2 * zFar * zNear * nf;
  return m;
}

function mat4Ortho(left: number, right: number, bottom: number, top: number, zNear: number, zFar: number): Float32Array {
  const m = new Float32Array(16);
  const rl = 1 / (right - left), tb = 1 / (top - bottom), fn = 1 / (zFar - zNear);
  m[0] = 2 * rl; m[5] = 2 * tb; m[10] = -2 * fn;
  m[12] = -(right + left) * rl; m[13] = -(top + bottom) * tb; m[14] = -(zFar + zNear) * fn; m[15] = 1;
  return m;
}

function mat4Frustum(left: number, right: number, bottom: number, top: number, zNear: number, zFar: number): Float32Array {
  const m = new Float32Array(16);
  const rl = 1 / (right - left), tb = 1 / (top - bottom), fn = 1 / (zFar - zNear);
  m[0] = 2 * zNear * rl; m[5] = 2 * zNear * tb;
  m[8] = (right + left) * rl; m[9] = (top + bottom) * tb; m[10] = -(zFar + zNear) * fn; m[11] = -1;
  m[14] = -2 * zFar * zNear * fn;
  return m;
}

function mat4LookAt(eyeX: number, eyeY: number, eyeZ: number,
                    centerX: number, centerY: number, centerZ: number,
                    upX: number, upY: number, upZ: number): Float32Array {
  let fx = centerX - eyeX, fy = centerY - eyeY, fz = centerZ - eyeZ;
  let fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
  if (fl > 0) { fx /= fl; fy /= fl; fz /= fl; }
  // s = f × up
  let sx = fy * upZ - fz * upY, sy = fz * upX - fx * upZ, sz = fx * upY - fy * upX;
  let sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (sl > 0) { sx /= sl; sy /= sl; sz /= sl; }
  // u = s × f
  const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
  const m = mat4Identity();
  m[0] = sx;  m[4] = sy;  m[8]  = sz;
  m[1] = ux;  m[5] = uy;  m[9]  = uz;
  m[2] = -fx; m[6] = -fy; m[10] = -fz;
  m[12] = -(sx * eyeX + sy * eyeY + sz * eyeZ);
  m[13] = -(ux * eyeX + uy * eyeY + uz * eyeZ);
  m[14] = (fx * eyeX + fy * eyeY + fz * eyeZ);
  m[15] = 1;
  return m;
}

const _normalMat = new Float32Array(9);
function mat3NormalFromMat4(m: Float32Array): Float32Array {
  const a00 = m[0], a01 = m[1], a02 = m[2];
  const a10 = m[4], a11 = m[5], a12 = m[6];
  const a20 = m[8], a21 = m[9], a22 = m[10];
  const det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
  const id = det !== 0 ? 1 / det : 0;
  const n = _normalMat;
  n[0] = (a11 * a22 - a21 * a12) * id;
  n[1] = (a20 * a12 - a10 * a22) * id;
  n[2] = (a10 * a21 - a20 * a11) * id;
  n[3] = (a21 * a02 - a01 * a22) * id;
  n[4] = (a00 * a22 - a20 * a02) * id;
  n[5] = (a20 * a01 - a00 * a21) * id;
  n[6] = (a01 * a12 - a11 * a02) * id;
  n[7] = (a10 * a02 - a00 * a12) * id;
  n[8] = (a00 * a11 - a10 * a01) * id;
  return n;
}

// Bernstein polynomial for Bezier evaluation
function bernstein(i: number, n: number, t: number): number {
  return binomial(n, i) * Math.pow(t, i) * Math.pow(1 - t, n - i);
}

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return r;
}

// Vertex shader source
const VERT_SRC = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec3 aNormal;
in vec4 aColor;
in vec2 aTexCoord;

uniform mat4 uModelView;
uniform mat4 uProjection;
uniform mat3 uNormalMatrix;

out vec3 vNormal;
out vec4 vColor;
out vec2 vTexCoord;
out vec3 vEyePos;

void main() {
  vec4 eyePos = uModelView * vec4(aPosition, 1.0);
  vEyePos = eyePos.xyz;
  gl_Position = uProjection * eyePos;
  vNormal = uNormalMatrix * aNormal;
  vColor = aColor;
  vTexCoord = aTexCoord;
}`;

// Fragment shader source
const FRAG_SRC = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec4 vColor;
in vec2 vTexCoord;
in vec3 vEyePos;

uniform bool uLightingEnabled;
uniform bool uLight0Enabled;
uniform bool uLight1Enabled;
uniform vec4 uLight0Position;
uniform vec4 uLight0Ambient;
uniform vec4 uLight0Diffuse;
uniform vec4 uLight1Position;
uniform vec4 uLight1Ambient;
uniform vec4 uLight1Diffuse;
uniform vec4 uLightModelAmbient;

uniform bool uTextureEnabled;
uniform sampler2D uTexture;
uniform int uTexEnvMode; // 0=modulate, 1=decal, 2=replace

out vec4 fragColor;

vec4 computeLight(bool enabled, vec4 lightPos, vec4 lightAmb, vec4 lightDiff, vec3 N, vec3 eyePos, vec4 matColor) {
  if (!enabled) return vec4(0.0);
  vec4 result = lightAmb * matColor;
  vec3 L;
  if (lightPos.w == 0.0) {
    L = normalize(lightPos.xyz);
  } else {
    L = normalize(lightPos.xyz - eyePos);
  }
  float NdotL = max(dot(N, L), 0.0);
  result += lightDiff * matColor * NdotL;
  return result;
}

void main() {
  vec4 baseColor = vColor;

  if (uLightingEnabled) {
    vec3 N = normalize(vNormal);
    vec4 litColor = uLightModelAmbient * baseColor;
    litColor += computeLight(uLight0Enabled, uLight0Position, uLight0Ambient, uLight0Diffuse, N, vEyePos, baseColor);
    litColor += computeLight(uLight1Enabled, uLight1Position, uLight1Ambient, uLight1Diffuse, N, vEyePos, baseColor);
    litColor.a = baseColor.a;
    baseColor = litColor;
  }

  if (uTextureEnabled) {
    vec4 texColor = texture(uTexture, vTexCoord);
    if (uTexEnvMode == 2) {
      baseColor = texColor;
    } else if (uTexEnvMode == 1) {
      baseColor = vec4(mix(baseColor.rgb, texColor.rgb, texColor.a), baseColor.a);
    } else {
      baseColor *= texColor;
    }
  }

  fragColor = baseColor;
}`;

interface LightState {
  position: Float32Array; // vec4 in eye space
  ambient: Float32Array;  // vec4
  diffuse: Float32Array;  // vec4
}

interface DisplayListEntry {
  fn: () => void;
}

export class GL1Context {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
  private program: WebGLProgram;

  // Attribute locations
  private aPosition: number;
  private aNormal: number;
  private aColor: number;
  private aTexCoord: number;

  // Uniform locations
  private uModelView: WebGLUniformLocation;
  private uProjection: WebGLUniformLocation;
  private uNormalMatrix: WebGLUniformLocation;
  private uLightingEnabled: WebGLUniformLocation;
  private uLight0Enabled: WebGLUniformLocation;
  private uLight1Enabled: WebGLUniformLocation;
  private uLight0Position: WebGLUniformLocation;
  private uLight0Ambient: WebGLUniformLocation;
  private uLight0Diffuse: WebGLUniformLocation;
  private uLight1Position: WebGLUniformLocation;
  private uLight1Ambient: WebGLUniformLocation;
  private uLight1Diffuse: WebGLUniformLocation;
  private uLightModelAmbient: WebGLUniformLocation;
  private uTextureEnabled: WebGLUniformLocation;
  private uTexture: WebGLUniformLocation;
  private uTexEnvMode: WebGLUniformLocation;

  // Matrix stacks
  private matrixMode = GL_MODELVIEW;
  private modelviewStack: Float32Array[] = [mat4Identity()];
  private projectionStack: Float32Array[] = [mat4Identity()];

  // Immediate mode — pre-allocated growing buffers
  private beginMode = -1;
  private imPos = new Float32Array(1024 * 3);
  private imNorm = new Float32Array(1024 * 3);
  private imCol = new Float32Array(1024 * 4);
  private imTc = new Float32Array(1024 * 2);
  private imCount = 0;   // number of vertices
  private imCapacity = 1024;
  private curNormal = [0, 0, 1];
  private curColor = [1, 1, 1, 1];
  private curTexCoord = [0, 0];

  // VBO/VAO
  private vao: WebGLVertexArrayObject;
  private posBuf: WebGLBuffer;
  private normBuf: WebGLBuffer;
  private colBuf: WebGLBuffer;
  private tcBuf: WebGLBuffer;

  // State
  private lightingEnabled = false;
  private light0Enabled = false;
  private light1Enabled = false;
  private textureEnabled = false;
  private light0: LightState;
  private light1: LightState;
  private lightModelAmbient = new Float32Array([0.2, 0.2, 0.2, 1.0]);
  private texEnvMode = GL_MODULATE;

  // Textures
  private textures = new Map<number, WebGLTexture>();
  private boundTexture = 0;

  // Display lists
  private displayLists = new Map<number, DisplayListEntry[]>();
  private recordingList = -1;
  listBase: number = 0;
  private recordingMode = GL_COMPILE;
  private currentRecording: DisplayListEntry[] = [];

  // Shade model
  private _shadeModel = GL_SMOOTH;
  private _lightModelTwoSide = false;
  private _shininess = 0;
  private autoNormalEnabled = false;

  // Vertex arrays (client-side)
  private vertexArrayEnabled = false;
  private normalArrayEnabled = false;
  private vertexArraySize = 3;
  private vertexArrayStride = 0;
  private vertexArrayData: Float32Array | null = null;
  private normalArrayStride = 0;
  private normalArrayData: Float32Array | null = null;

  // Reusable EBO for quads/quad_strip
  private eboBuf: WebGLBuffer | null = null;

  // Uniform dirty flag
  private uniformsDirty = true;

  // Debug counter
  drawCount = 0;

  constructor(width: number, height: number) {
    this.canvas = new OffscreenCanvas(width, height);
    const gl = this.canvas.getContext('webgl2', {
      preserveDrawingBuffer: true,
      alpha: false,
      depth: true,
      antialias: true,
    });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;

    // Compile shaders
    const vs = this.compileShader(gl.VERTEX_SHADER, VERT_SRC);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error('Shader link: ' + gl.getProgramInfoLog(this.program));
    }
    gl.useProgram(this.program);

    // Get locations
    this.aPosition = gl.getAttribLocation(this.program, 'aPosition');
    this.aNormal = gl.getAttribLocation(this.program, 'aNormal');
    this.aColor = gl.getAttribLocation(this.program, 'aColor');
    this.aTexCoord = gl.getAttribLocation(this.program, 'aTexCoord');

    this.uModelView = gl.getUniformLocation(this.program, 'uModelView')!;
    this.uProjection = gl.getUniformLocation(this.program, 'uProjection')!;
    this.uNormalMatrix = gl.getUniformLocation(this.program, 'uNormalMatrix')!;
    this.uLightingEnabled = gl.getUniformLocation(this.program, 'uLightingEnabled')!;
    this.uLight0Enabled = gl.getUniformLocation(this.program, 'uLight0Enabled')!;
    this.uLight1Enabled = gl.getUniformLocation(this.program, 'uLight1Enabled')!;
    this.uLight0Position = gl.getUniformLocation(this.program, 'uLight0Position')!;
    this.uLight0Ambient = gl.getUniformLocation(this.program, 'uLight0Ambient')!;
    this.uLight0Diffuse = gl.getUniformLocation(this.program, 'uLight0Diffuse')!;
    this.uLight1Position = gl.getUniformLocation(this.program, 'uLight1Position')!;
    this.uLight1Ambient = gl.getUniformLocation(this.program, 'uLight1Ambient')!;
    this.uLight1Diffuse = gl.getUniformLocation(this.program, 'uLight1Diffuse')!;
    this.uLightModelAmbient = gl.getUniformLocation(this.program, 'uLightModelAmbient')!;
    this.uTextureEnabled = gl.getUniformLocation(this.program, 'uTextureEnabled')!;
    this.uTexture = gl.getUniformLocation(this.program, 'uTexture')!;
    this.uTexEnvMode = gl.getUniformLocation(this.program, 'uTexEnvMode')!;

    // Create VAO and buffers
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.posBuf = gl.createBuffer()!;
    this.normBuf = gl.createBuffer()!;
    this.colBuf = gl.createBuffer()!;
    this.tcBuf = gl.createBuffer()!;

    this.eboBuf = gl.createBuffer()!;

    // Setup attributes
    this.setupAttrib(this.aPosition, this.posBuf, 3);
    this.setupAttrib(this.aNormal, this.normBuf, 3);
    this.setupAttrib(this.aColor, this.colBuf, 4);
    this.setupAttrib(this.aTexCoord, this.tcBuf, 2);

    // Default state
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1.0);

    // Light defaults
    this.light0 = {
      position: new Float32Array([0, 0, 1, 0]),
      ambient: new Float32Array([0, 0, 0, 1]),
      diffuse: new Float32Array([1, 1, 1, 1]),
    };
    this.light1 = {
      position: new Float32Array([0, 0, 1, 0]),
      ambient: new Float32Array([0, 0, 0, 1]),
      diffuse: new Float32Array([1, 1, 1, 1]),
    };

    // Create default texture 0 (desktop OpenGL has a default texture; WebGL does not)
    const defaultTex = gl.createTexture()!;
    this.textures.set(0, defaultTex);
    gl.bindTexture(gl.TEXTURE_2D, defaultTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private compileShader(type: number, src: string): WebGLShader {
    const s = this.gl.createShader(type)!;
    this.gl.shaderSource(s, src);
    this.gl.compileShader(s);
    if (!this.gl.getShaderParameter(s, this.gl.COMPILE_STATUS)) {
      throw new Error('Shader compile: ' + this.gl.getShaderInfoLog(s));
    }
    return s;
  }

  private setupAttrib(loc: number, buf: WebGLBuffer, size: number): void {
    if (loc < 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  private get currentMatrix(): Float32Array {
    const stack = this.matrixMode === GL_PROJECTION ? this.projectionStack : this.modelviewStack;
    return stack[stack.length - 1];
  }

  private set currentMatrix(m: Float32Array) {
    const stack = this.matrixMode === GL_PROJECTION ? this.projectionStack : this.modelviewStack;
    stack[stack.length - 1] = m;
  }

  get modelview(): Float32Array { return this.modelviewStack[this.modelviewStack.length - 1]; }
  get projection(): Float32Array { return this.projectionStack[this.projectionStack.length - 1]; }

  private markDirty(): void { this.uniformsDirty = true; }

  private syncUniforms(): void {
    if (!this.uniformsDirty) return;
    this.uniformsDirty = false;
    const gl = this.gl;
    gl.uniformMatrix4fv(this.uModelView, false, this.modelview);
    gl.uniformMatrix4fv(this.uProjection, false, this.projection);
    gl.uniformMatrix3fv(this.uNormalMatrix, false, mat3NormalFromMat4(this.modelview));
    gl.uniform1i(this.uLightingEnabled, this.lightingEnabled ? 1 : 0);
    gl.uniform1i(this.uLight0Enabled, this.light0Enabled ? 1 : 0);
    gl.uniform1i(this.uLight1Enabled, this.light1Enabled ? 1 : 0);
    gl.uniform4fv(this.uLight0Position, this.light0.position);
    gl.uniform4fv(this.uLight0Ambient, this.light0.ambient);
    gl.uniform4fv(this.uLight0Diffuse, this.light0.diffuse);
    gl.uniform4fv(this.uLight1Position, this.light1.position);
    gl.uniform4fv(this.uLight1Ambient, this.light1.ambient);
    gl.uniform4fv(this.uLight1Diffuse, this.light1.diffuse);
    gl.uniform4fv(this.uLightModelAmbient, this.lightModelAmbient);
    gl.uniform1i(this.uTextureEnabled, this.textureEnabled ? 1 : 0);
    gl.uniform1i(this.uTexture, 0);
    const envMode = this.texEnvMode === GL_DECAL ? 1 : this.texEnvMode === GL_REPLACE ? 2 : 0;
    gl.uniform1i(this.uTexEnvMode, envMode);
  }

  // Record or execute a command
  private cmd(fn: () => void): void {
    if (this.recordingList >= 0) {
      this.currentRecording.push({ fn });
      if (this.recordingMode === GL_COMPILE_AND_EXECUTE) {
        fn();
        this.uniformsDirty = true;
      }
    } else {
      fn();
      this.uniformsDirty = true;
    }
  }

  // Public GL API methods

  matrixModeSet(mode: number): void { this.cmd(() => { this.matrixMode = mode; }); }

  loadIdentity(): void { this.cmd(() => { this.currentMatrix = mat4Identity(); }); }

  pushMatrix(): void {
    this.cmd(() => {
      const stack = this.matrixMode === GL_PROJECTION ? this.projectionStack : this.modelviewStack;
      stack.push(new Float32Array(stack[stack.length - 1]));
    });
  }

  popMatrix(): void {
    this.cmd(() => {
      const stack = this.matrixMode === GL_PROJECTION ? this.projectionStack : this.modelviewStack;
      if (stack.length > 1) stack.pop();
    });
  }

  translatef(x: number, y: number, z: number): void {
    this.cmd(() => { this.currentMatrix = mat4Translate(this.currentMatrix, x, y, z); });
  }

  rotatef(angle: number, x: number, y: number, z: number): void {
    this.cmd(() => { this.currentMatrix = mat4Rotate(this.currentMatrix, angle, x, y, z); });
  }

  scalef(x: number, y: number, z: number): void {
    this.cmd(() => { this.currentMatrix = mat4Scale(this.currentMatrix, x, y, z); });
  }

  perspective(fovy: number, aspect: number, zNear: number, zFar: number): void {
    this.cmd(() => {
      this.currentMatrix = mat4Multiply(this.currentMatrix, mat4Perspective(fovy, aspect, zNear, zFar));
    });
  }

  ortho2D(left: number, right: number, bottom: number, top: number): void {
    this.cmd(() => {
      this.currentMatrix = mat4Multiply(this.currentMatrix, mat4Ortho(left, right, bottom, top, -1, 1));
    });
  }

  lookAt(eyeX: number, eyeY: number, eyeZ: number,
         centerX: number, centerY: number, centerZ: number,
         upX: number, upY: number, upZ: number): void {
    this.cmd(() => {
      this.currentMatrix = mat4Multiply(this.currentMatrix, mat4LookAt(eyeX, eyeY, eyeZ, centerX, centerY, centerZ, upX, upY, upZ));
    });
  }

  viewport(x: number, y: number, w: number, h: number): void {
    this.cmd(() => { this.gl.viewport(x, y, w, h); });
  }

  scissor(x: number, y: number, w: number, h: number): void {
    this.cmd(() => { this.gl.scissor(x, y, w, h); });
  }

  enable(cap: number): void {
    this.cmd(() => {
      const gl = this.gl;
      switch (cap) {
        case GL_DEPTH_TEST: gl.enable(gl.DEPTH_TEST); break;
        case GL_CULL_FACE: gl.enable(gl.CULL_FACE); break;
        case GL_BLEND: gl.enable(gl.BLEND); break;
        case GL_SCISSOR_TEST: gl.enable(gl.SCISSOR_TEST); break;
        case GL_LIGHTING: this.lightingEnabled = true; break;
        case GL_LIGHT0: this.light0Enabled = true; break;
        case GL_LIGHT1: this.light1Enabled = true; break;
        case GL_TEXTURE_2D: this.textureEnabled = true; break;
        case GL_NORMALIZE: break; // handled in shader
        case GL_COLOR_MATERIAL: break; // always on in our impl
        case GL_AUTO_NORMAL: this.autoNormalEnabled = true; break;
        case GL_MAP2_VERTEX_3: case GL_MAP2_VERTEX_4: case GL_MAP2_NORMAL: break; // tracked via evalMaps
      }
    });
  }

  disable(cap: number): void {
    this.cmd(() => {
      const gl = this.gl;
      switch (cap) {
        case GL_DEPTH_TEST: gl.disable(gl.DEPTH_TEST); break;
        case GL_CULL_FACE: gl.disable(gl.CULL_FACE); break;
        case GL_BLEND: gl.disable(gl.BLEND); break;
        case GL_SCISSOR_TEST: gl.disable(gl.SCISSOR_TEST); break;
        case GL_LIGHTING: this.lightingEnabled = false; break;
        case GL_LIGHT0: this.light0Enabled = false; break;
        case GL_LIGHT1: this.light1Enabled = false; break;
        case GL_TEXTURE_2D: this.textureEnabled = false; break;
        case GL_NORMALIZE: break;
        case GL_COLOR_MATERIAL: break;
        case GL_AUTO_NORMAL: this.autoNormalEnabled = false; break;
        case GL_MAP2_VERTEX_3: case GL_MAP2_VERTEX_4: case GL_MAP2_NORMAL: break;
      }
    });
  }

  cullFace(mode: number): void {
    this.cmd(() => {
      this.gl.cullFace(mode === GL_FRONT ? this.gl.FRONT : mode === GL_FRONT_AND_BACK ? this.gl.FRONT_AND_BACK : this.gl.BACK);
    });
  }

  frontFace(mode: number): void {
    this.cmd(() => { this.gl.frontFace(mode === GL_CW ? this.gl.CW : this.gl.CCW); });
  }

  shadeModel(mode: number): void {
    this.cmd(() => { this._shadeModel = mode; });
  }

  colorMask(r: boolean, g: boolean, b: boolean, a: boolean): void {
    this.cmd(() => { this.gl.colorMask(r, g, b, a); });
  }

  depthMask(flag: boolean): void {
    this.cmd(() => { this.gl.depthMask(flag); });
  }

  stencilMask(mask: number): void {
    this.cmd(() => { this.gl.stencilMask(mask); });
  }

  stencilFunc(func: number, ref: number, mask: number): void {
    this.cmd(() => { this.gl.stencilFunc(func, ref, mask); });
  }

  stencilOp(fail: number, zfail: number, zpass: number): void {
    this.cmd(() => { this.gl.stencilOp(fail, zfail, zpass); });
  }

  clearStencil(s: number): void {
    this.cmd(() => { this.gl.clearStencil(s); });
  }

  polygonOffset(factor: number, units: number): void {
    this.cmd(() => { this.gl.polygonOffset(factor, units); });
  }

  blendFunc(sfactor: number, dfactor: number): void {
    this.cmd(() => {
      this.gl.blendFunc(this.mapBlendFactor(sfactor), this.mapBlendFactor(dfactor));
    });
  }

  private mapBlendFactor(f: number): number {
    const gl = this.gl;
    switch (f) {
      case 0: return gl.ZERO;
      case 1: return gl.ONE;
      case GL_SRC_ALPHA: return gl.SRC_ALPHA;
      case GL_ONE_MINUS_SRC_ALPHA: return gl.ONE_MINUS_SRC_ALPHA;
      default: return gl.ONE;
    }
  }

  clear(mask: number): void {
    this.cmd(() => {
      let bits = 0;
      if (mask & GL_COLOR_BUFFER_BIT) bits |= this.gl.COLOR_BUFFER_BIT;
      if (mask & GL_DEPTH_BUFFER_BIT) bits |= this.gl.DEPTH_BUFFER_BIT;
      this.gl.clear(bits);
    });
  }

  clearDepth(d: number): void {
    this.cmd(() => { this.gl.clearDepth(d); });
  }

  clearColor(r: number, g: number, b: number, a: number): void {
    this.cmd(() => { this.gl.clearColor(r, g, b, a); });
  }

  depthFunc(func: number): void {
    this.cmd(() => {
      const gl = this.gl;
      const map: Record<number, number> = {
        0x0200: gl.NEVER, 0x0201: gl.LESS, 0x0202: gl.EQUAL, 0x0203: gl.LEQUAL,
        0x0204: gl.GREATER, 0x0205: gl.NOTEQUAL, 0x0206: gl.GEQUAL, 0x0207: gl.ALWAYS,
      };
      gl.depthFunc(map[func] ?? gl.LESS);
    });
  }

  ortho(left: number, right: number, bottom: number, top: number, zNear: number, zFar: number): void {
    this.cmd(() => {
      this.currentMatrix = mat4Multiply(this.currentMatrix, mat4Ortho(left, right, bottom, top, zNear, zFar));
    });
  }

  frustum(left: number, right: number, bottom: number, top: number, zNear: number, zFar: number): void {
    this.cmd(() => {
      this.currentMatrix = mat4Multiply(this.currentMatrix, mat4Frustum(left, right, bottom, top, zNear, zFar));
    });
  }

  hint(target: number, mode: number): void {
    this.cmd(() => {
      // WebGL only supports GL_GENERATE_MIPMAP_HINT (0x8192)
      if (target === 0x8192) {
        const glMode = mode === 0x1101 /* GL_FASTEST */ ? this.gl.FASTEST
          : mode === 0x1102 /* GL_NICEST */ ? this.gl.NICEST : this.gl.DONT_CARE;
        this.gl.hint(this.gl.GENERATE_MIPMAP_HINT, glMode);
      }
      // Other hints (GL_PERSPECTIVE_CORRECTION_HINT, GL_POINT_SMOOTH_HINT, etc.) not supported in WebGL
    });
  }

  private _polygonFrontMode = GL_FILL;
  private _polygonBackMode = GL_FILL;
  polygonMode(face: number, mode: number): void {
    this.cmd(() => {
      // WebGL doesn't support glPolygonMode — store for reference but can't apply
      if (face === GL_FRONT || face === GL_FRONT_AND_BACK) this._polygonFrontMode = mode;
      if (face === GL_BACK || face === GL_FRONT_AND_BACK) this._polygonBackMode = mode;
      // GL_LINE (0x1B01) wireframe not possible in WebGL; GL_FILL is always used
    });
  }
  pixelStorei(pname: number, param: number): void {
    this.cmd(() => {
      // Map GL1.x pname to WebGL — only UNPACK_ALIGNMENT relevant
      if (pname === 0x0CF5) this.gl.pixelStorei(this.gl.UNPACK_ALIGNMENT, param);
    });
  }

  // Lighting
  lightfv(light: number, pname: number, params: Float32Array): void {
    this.cmd(() => {
      const ls = light === GL_LIGHT0 ? this.light0 : this.light1;
      if (pname === GL_POSITION) {
        // Transform position by current modelview
        const p = params;
        const mv = this.modelview;
        const ep = new Float32Array(4);
        for (let i = 0; i < 4; i++) {
          ep[i] = mv[i] * p[0] + mv[4 + i] * p[1] + mv[8 + i] * p[2] + mv[12 + i] * p[3];
        }
        ls.position = ep;
      } else if (pname === GL_AMBIENT) {
        ls.ambient = new Float32Array(params);
      } else if (pname === GL_DIFFUSE) {
        ls.diffuse = new Float32Array(params);
      } else if (pname === GL_SPECULAR) {
        // ignore specular for now
      } else if (pname === GL_AMBIENT_AND_DIFFUSE) {
        ls.ambient = new Float32Array(params);
        ls.diffuse = new Float32Array(params);
      }
    });
  }

  lightModelfv(pname: number, params: Float32Array): void {
    this.cmd(() => {
      if (pname === GL_LIGHT_MODEL_AMBIENT) {
        this.lightModelAmbient = new Float32Array(params);
      }
    });
  }

  lightModeli(pname: number, param: number): void {
    this.cmd(() => {
      if (pname === GL_LIGHT_MODEL_TWO_SIDE) {
        this._lightModelTwoSide = param !== 0;
      }
    });
  }

  texEnvi(_target: number, pname: number, param: number): void {
    this.cmd(() => {
      if (pname === GL_TEXTURE_ENV_MODE) this.texEnvMode = param;
    });
  }

  // Textures
  genTextures(n: number): number[] {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const tex = this.gl.createTexture()!;
      const id = this.nextTexId++;
      this.textures.set(id, tex);
      ids.push(id);
    }
    return ids;
  }
  private nextTexId = 1;

  deleteTextures(ids: number[]): void {
    for (const id of ids) {
      const tex = this.textures.get(id);
      if (tex) { this.gl.deleteTexture(tex); this.textures.delete(id); }
    }
  }

  bindTexture(_target: number, id: number): void {
    this.cmd(() => {
      this.boundTexture = id;
      const tex = this.textures.get(id);
      this.gl.bindTexture(this.gl.TEXTURE_2D, tex || null);
    });
  }

  texParameteri(_target: number, pname: number, param: number): void {
    this.cmd(() => {
      const gl = this.gl;
      const glPname = pname === GL_TEXTURE_MAG_FILTER ? gl.TEXTURE_MAG_FILTER :
                      pname === GL_TEXTURE_MIN_FILTER ? gl.TEXTURE_MIN_FILTER :
                      pname === GL_TEXTURE_WRAP_S ? gl.TEXTURE_WRAP_S :
                      pname === GL_TEXTURE_WRAP_T ? gl.TEXTURE_WRAP_T : 0;
      if (!glPname) return;
      let glParam: number;
      switch (param) {
        case GL_NEAREST: glParam = gl.LINEAR; break; // Force linear filtering for anti-aliased textures
        case GL_LINEAR: glParam = gl.LINEAR; break;
        case GL_NEAREST_MIPMAP_NEAREST: glParam = gl.LINEAR_MIPMAP_LINEAR; break;
        case GL_LINEAR_MIPMAP_NEAREST: glParam = gl.LINEAR_MIPMAP_LINEAR; break;
        case GL_NEAREST_MIPMAP_LINEAR: glParam = gl.LINEAR_MIPMAP_LINEAR; break;
        case GL_LINEAR_MIPMAP_LINEAR: glParam = gl.LINEAR_MIPMAP_LINEAR; break;
        case GL_REPEAT: glParam = gl.REPEAT; break;
        case GL_CLAMP: case GL_CLAMP_TO_EDGE: glParam = gl.CLAMP_TO_EDGE; break;
        default: glParam = param; break;
      }
      gl.texParameteri(gl.TEXTURE_2D, glPname, glParam);
    });
  }

  texImage2D(target: number, level: number, internalFormat: number,
             width: number, height: number, border: number,
             format: number, type: number, pixels: Uint8Array | null): void {
    this.cmd(() => {
      const gl = this.gl;
      let glFormat: number;
      let glInternal: number;
      if (format === GL_RGBA || internalFormat === GL_RGBA || internalFormat === 4) {
        glFormat = gl.RGBA; glInternal = gl.RGBA;
      } else if (format === GL_RGB || internalFormat === GL_RGB || internalFormat === 3) {
        glFormat = gl.RGB; glInternal = gl.RGB;
      } else if (format === GL_LUMINANCE || internalFormat === GL_LUMINANCE || internalFormat === 1) {
        glFormat = gl.LUMINANCE; glInternal = gl.LUMINANCE;
      } else if (format === GL_LUMINANCE_ALPHA || internalFormat === GL_LUMINANCE_ALPHA || internalFormat === 2) {
        glFormat = gl.LUMINANCE_ALPHA; glInternal = gl.LUMINANCE_ALPHA;
      } else {
        glFormat = gl.RGBA; glInternal = gl.RGBA;
      }
      gl.texImage2D(gl.TEXTURE_2D, level, glInternal, width, height, border, glFormat, gl.UNSIGNED_BYTE, pixels);
    });
  }

  build2DMipmaps(target: number, internalFormat: number,
                 width: number, height: number,
                 format: number, type: number, pixels: Uint8Array | null): void {
    this.cmd(() => {
      const gl = this.gl;
      let glFormat: number;
      let glInternal: number;
      if (format === GL_RGBA || internalFormat === GL_RGBA || internalFormat === 4) {
        glFormat = gl.RGBA; glInternal = gl.RGBA;
      } else if (format === GL_RGB || internalFormat === GL_RGB || internalFormat === 3) {
        glFormat = gl.RGB; glInternal = gl.RGB;
      } else if (format === GL_LUMINANCE || internalFormat === GL_LUMINANCE || internalFormat === 1) {
        glFormat = gl.LUMINANCE; glInternal = gl.LUMINANCE;
      } else if (format === GL_LUMINANCE_ALPHA || internalFormat === GL_LUMINANCE_ALPHA || internalFormat === 2) {
        glFormat = gl.LUMINANCE_ALPHA; glInternal = gl.LUMINANCE_ALPHA;
      } else {
        glFormat = gl.RGBA; glInternal = gl.RGBA;
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, glInternal, width, height, 0, glFormat, gl.UNSIGNED_BYTE, pixels);
      gl.generateMipmap(gl.TEXTURE_2D);
    });
  }

  // Immediate mode
  begin(mode: number): void {
    this.beginMode = mode;
    this.imCount = 0;
  }

  private ensureImCapacity(needed: number): void {
    if (needed <= this.imCapacity) return;
    let cap = this.imCapacity;
    while (cap < needed) cap *= 2;
    const p = new Float32Array(cap * 3); p.set(this.imPos.subarray(0, this.imCount * 3)); this.imPos = p;
    const n = new Float32Array(cap * 3); n.set(this.imNorm.subarray(0, this.imCount * 3)); this.imNorm = n;
    const c = new Float32Array(cap * 4); c.set(this.imCol.subarray(0, this.imCount * 4)); this.imCol = c;
    const t = new Float32Array(cap * 2); t.set(this.imTc.subarray(0, this.imCount * 2)); this.imTc = t;
    this.imCapacity = cap;
  }

  end(): void {
    if (this.beginMode < 0) return;
    const mode = this.beginMode;
    const count = this.imCount;
    // Snapshot into compact typed arrays for the cmd closure
    const positions = this.imPos.slice(0, count * 3);
    const normals = this.imNorm.slice(0, count * 3);
    const colors = this.imCol.slice(0, count * 4);
    const texCoords = this.imTc.slice(0, count * 2);
    this.beginMode = -1;

    this.cmd(() => {
      this.flushImmediate(mode, positions, normals, colors, texCoords);
    });
  }

  private flushImmediate(mode: number, positions: Float32Array, normals: Float32Array, colors: Float32Array, texCoords: Float32Array): void {
    const gl = this.gl;
    const vertCount = positions.length / 3;
    if (vertCount === 0) return;

    this.syncUniforms();

    // Upload data
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.normBuf);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tcBuf);
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.DYNAMIC_DRAW);

    this.drawCount++;
    if (mode === GL_QUADS) {
      const quadCount = Math.floor(vertCount / 4);
      const indices = new Uint16Array(quadCount * 6);
      for (let i = 0; i < quadCount; i++) {
        const base = i * 4;
        indices[i * 6] = base; indices[i * 6 + 1] = base + 1; indices[i * 6 + 2] = base + 2;
        indices[i * 6 + 3] = base; indices[i * 6 + 4] = base + 2; indices[i * 6 + 5] = base + 3;
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.eboBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
      gl.drawElements(gl.TRIANGLES, quadCount * 6, gl.UNSIGNED_SHORT, 0);
    } else if (mode === GL_QUAD_STRIP) {
      const quadCount = Math.floor((vertCount - 2) / 2);
      const indices = new Uint16Array(quadCount * 6);
      for (let i = 0; i < quadCount; i++) {
        const base = i * 2;
        indices[i * 6]     = base;     indices[i * 6 + 1] = base + 1; indices[i * 6 + 2] = base + 3;
        indices[i * 6 + 3] = base;     indices[i * 6 + 4] = base + 3; indices[i * 6 + 5] = base + 2;
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.eboBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
      gl.drawElements(gl.TRIANGLES, quadCount * 6, gl.UNSIGNED_SHORT, 0);
    } else if (mode === GL_POLYGON) {
      // Triangle fan
      gl.drawArrays(gl.TRIANGLE_FAN, 0, vertCount);
    } else {
      const glMode = mode === GL_TRIANGLES ? gl.TRIANGLES :
                     mode === GL_TRIANGLE_STRIP ? gl.TRIANGLE_STRIP :
                     mode === GL_TRIANGLE_FAN ? gl.TRIANGLE_FAN :
                     mode === GL_LINES ? gl.LINES :
                     mode === GL_LINE_STRIP ? gl.LINE_STRIP :
                     mode === GL_POINTS ? gl.POINTS : gl.TRIANGLES;
      gl.drawArrays(glMode, 0, vertCount);
    }
  }

  vertex3f(x: number, y: number, z: number): void {
    const i = this.imCount;
    this.ensureImCapacity(i + 1);
    const p3 = i * 3, p4 = i * 4, p2 = i * 2;
    this.imPos[p3] = x; this.imPos[p3 + 1] = y; this.imPos[p3 + 2] = z;
    this.imNorm[p3] = this.curNormal[0]; this.imNorm[p3 + 1] = this.curNormal[1]; this.imNorm[p3 + 2] = this.curNormal[2];
    this.imCol[p4] = this.curColor[0]; this.imCol[p4 + 1] = this.curColor[1]; this.imCol[p4 + 2] = this.curColor[2]; this.imCol[p4 + 3] = this.curColor[3];
    this.imTc[p2] = this.curTexCoord[0]; this.imTc[p2 + 1] = this.curTexCoord[1];
    this.imCount = i + 1;
  }

  vertex2f(x: number, y: number): void { this.vertex3f(x, y, 0); }

  normal3f(x: number, y: number, z: number): void {
    this.curNormal[0] = x; this.curNormal[1] = y; this.curNormal[2] = z;
  }

  color3f(r: number, g: number, b: number): void {
    this.curColor[0] = r; this.curColor[1] = g; this.curColor[2] = b; this.curColor[3] = 1;
  }

  color4f(r: number, g: number, b: number, a: number): void {
    this.curColor[0] = r; this.curColor[1] = g; this.curColor[2] = b; this.curColor[3] = a;
  }

  texCoord2f(s: number, t: number): void {
    this.curTexCoord[0] = s; this.curTexCoord[1] = t;
  }

  // Display lists
  newList(list: number, mode: number): void {
    this.recordingList = list;
    this.recordingMode = mode;
    this.currentRecording = [];
  }

  endList(): void {
    if (this.recordingList >= 0) {
      this.displayLists.set(this.recordingList, this.currentRecording);
      this.recordingList = -1;
      this.currentRecording = [];
    }
  }

  callList(list: number): void {
    this.cmd(() => {
      const entries = this.displayLists.get(list);
      if (entries) {
        for (const e of entries) e.fn();
      }
    });
  }

  isList(list: number): boolean {
    return this.displayLists.has(list);
  }

  deleteLists(list: number, range: number): void {
    for (let i = 0; i < range; i++) this.displayLists.delete(list + i);
  }

  // Material (store for lighting; simplified — just set curColor for ambient/diffuse)
  materialfv(_face: number, pname: number, params: Float32Array): void {
    // GL_AMBIENT_AND_DIFFUSE=0x1602, GL_DIFFUSE=0x1201, GL_AMBIENT=0x1200, GL_SPECULAR=0x1202, GL_SHININESS=0x1601
    // Update curColor immediately so subsequent vertex3f calls pick it up
    if (pname === 0x1602 || pname === 0x1201) {
      this.curColor[0] = params[0]; this.curColor[1] = params[1];
      this.curColor[2] = params[2]; this.curColor[3] = params[3];
    }
  }

  materialf(_face: number, pname: number, param: number): void {
    this.cmd(() => {
      // GL_SHININESS = 0x1601 — store for lighting calculation
      if (pname === 0x1601) {
        this._shininess = Math.max(0, Math.min(128, param));
      }
    });
  }

  // Evaluators — sspipes uses glMap2f to define Bezier/NURBS patches, then glEvalMesh2 to tessellate
  private evalMaps = new Map<number, { u1: number; u2: number; ustride: number; uorder: number; v1: number; v2: number; vstride: number; vorder: number; points: Float32Array }>();
  private evalGridUn = 1; private evalGridU1 = 0; private evalGridU2 = 1;
  private evalGridVn = 1; private evalGridV1 = 0; private evalGridV2 = 1;

  map2f(target: number, u1: number, u2: number, ustride: number, uorder: number,
        v1: number, v2: number, vstride: number, vorder: number, points: Float32Array): void {
    this.cmd(() => {
      this.evalMaps.set(target, { u1, u2, ustride, uorder, v1, v2, vstride, vorder, points: new Float32Array(points) });
    });
  }

  mapGrid2f(un: number, u1: number, u2: number, vn: number, v1: number, v2: number): void {
    this.cmd(() => {
      this.evalGridUn = un; this.evalGridU1 = u1; this.evalGridU2 = u2;
      this.evalGridVn = vn; this.evalGridV1 = v1; this.evalGridV2 = v2;
    });
  }

  evalMesh2(mode: number, i1: number, i2: number, j1: number, j2: number): void {
    this.cmd(() => {
      const vertMap = this.evalMaps.get(GL_MAP2_VERTEX_3) || this.evalMaps.get(GL_MAP2_VERTEX_4);
      const normMap = this.evalMaps.get(GL_MAP2_NORMAL);
      if (!vertMap) return;

      const vSize = this.evalMaps.has(GL_MAP2_VERTEX_4) ? 4 : 3;
      const du = (this.evalGridU2 - this.evalGridU1) / this.evalGridUn;
      const dv = (this.evalGridV2 - this.evalGridV1) / this.evalGridVn;

      const evalPoint = (map: typeof vertMap, u: number, v: number, size: number): number[] => {
        const { u1: mu1, u2: mu2, uorder, v1: mv1, v2: mv2, vorder, points, ustride, vstride } = map;
        const s = mu2 !== mu1 ? (u - mu1) / (mu2 - mu1) : 0;
        const t = mv2 !== mv1 ? (v - mv1) / (mv2 - mv1) : 0;
        const result = new Array(size).fill(0);
        for (let j = 0; j < vorder; j++) {
          const bv = bernstein(j, vorder - 1, t);
          for (let i = 0; i < uorder; i++) {
            const bu = bernstein(i, uorder - 1, s);
            const w = bu * bv;
            const base = j * vstride + i * ustride;
            for (let k = 0; k < size; k++) result[k] += points[base + k] * w;
          }
        }
        return result;
      };

      // Compute auto-normal via cross product of partial derivatives (finite differences)
      const computeAutoNormal = (u: number, v: number): [number, number, number] => {
        const eps = 0.001;
        const p = evalPoint(vertMap, u, v, 3);
        const pu = evalPoint(vertMap, u + eps, v, 3);
        const pv = evalPoint(vertMap, u, v + eps, 3);
        const dPdu = [pu[0] - p[0], pu[1] - p[1], pu[2] - p[2]];
        const dPdv = [pv[0] - p[0], pv[1] - p[1], pv[2] - p[2]];
        // cross product dPdu × dPdv
        let nx = dPdu[1] * dPdv[2] - dPdu[2] * dPdv[1];
        let ny = dPdu[2] * dPdv[0] - dPdu[0] * dPdv[2];
        let nz = dPdu[0] * dPdv[1] - dPdu[1] * dPdv[0];
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 1e-10) { nx /= len; ny /= len; nz /= len; }
        return [nx, ny, nz];
      };

      const useAutoNormal = this.autoNormalEnabled && !normMap;

      for (let j = j1; j < j2; j++) {
        const v0 = this.evalGridV1 + j * dv;
        const v1 = this.evalGridV1 + (j + 1) * dv;
        if (mode === 0x1B02) { // GL_FILL
          this.begin(GL_TRIANGLE_STRIP);
          for (let i = i1; i <= i2; i++) {
            const u = this.evalGridU1 + i * du;
            // Vertex at (u, v0)
            if (normMap) {
              const n = evalPoint(normMap, u, v0, 3);
              this.normal3f(n[0], n[1], n[2]);
            } else if (useAutoNormal) {
              const [nx, ny, nz] = computeAutoNormal(u, v0);
              this.normal3f(nx, ny, nz);
            }
            const p0 = evalPoint(vertMap, u, v0, vSize);
            this.vertex3f(p0[0], p0[1], p0[2]);
            // Vertex at (u, v1)
            if (normMap) {
              const n = evalPoint(normMap, u, v1, 3);
              this.normal3f(n[0], n[1], n[2]);
            } else if (useAutoNormal) {
              const [nx, ny, nz] = computeAutoNormal(u, v1);
              this.normal3f(nx, ny, nz);
            }
            const p1 = evalPoint(vertMap, u, v1, vSize);
            this.vertex3f(p1[0], p1[1], p1[2]);
          }
          this.end();
        } else {
          this.begin(GL_LINE_STRIP);
          for (let i = i1; i <= i2; i++) {
            const u = this.evalGridU1 + i * du;
            const p = evalPoint(vertMap, u, v0, vSize);
            this.vertex3f(p[0], p[1], p[2]);
          }
          this.end();
        }
      }
    });
  }

  // glGetString
  getString(name: number): string {
    switch (name) {
      case GL_VENDOR: return 'WebGL Emulator';
      case GL_RENDERER: return 'GL1Context';
      case GL_VERSION: return '1.1.0';
      case GL_EXTENSIONS: return '';
      default: return '';
    }
  }

  // glGetIntegerv
  getIntegerv(pname: number): number {
    switch (pname) {
      case GL_MAX_TEXTURE_SIZE: return 4096;
      case GL_MAX_LIGHTS: return 2;
      default: return 0;
    }
  }

  // Return a 4-entry viewport array [x,y,w,h], or null if pname is not GL_VIEWPORT.
  getViewport(): [number, number, number, number] {
    const p = this.gl.getParameter(this.gl.VIEWPORT);
    return [p[0], p[1], p[2], p[3]];
  }

  // Return the current projection or modelview matrix as a 16-entry Float32Array (column-major).
  getMatrix(pname: number): Float32Array | null {
    // GL_MODELVIEW_MATRIX=0x0BA6, GL_PROJECTION_MATRIX=0x0BA7
    if (pname === 0x0BA6) return this.modelview;
    if (pname === 0x0BA7) return this.projection;
    return null;
  }

  getTexEnviv(pname: number): number {
    if (pname === GL_TEXTURE_ENV_MODE) return this.texEnvMode;
    return 0;
  }

  resize(w: number, h: number): void {
    this.canvas.width = w;
    this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  // Vertex array API
  enableClientState(cap: number): void {
    if (cap === GL_VERTEX_ARRAY) this.vertexArrayEnabled = true;
    else if (cap === GL_NORMAL_ARRAY) this.normalArrayEnabled = true;
  }

  disableClientState(cap: number): void {
    if (cap === GL_VERTEX_ARRAY) this.vertexArrayEnabled = false;
    else if (cap === GL_NORMAL_ARRAY) this.normalArrayEnabled = false;
  }

  vertexPointer(size: number, _type: number, stride: number, data: Float32Array): void {
    this.vertexArraySize = size;
    this.vertexArrayStride = stride;
    this.vertexArrayData = new Float32Array(data);
  }

  normalPointer(_type: number, stride: number, data: Float32Array): void {
    this.normalArrayStride = stride;
    this.normalArrayData = new Float32Array(data);
  }

  drawElements(mode: number, count: number, indices: Uint16Array | Uint32Array): void {
    // Snapshot arrays now since emulator memory may change
    const vaEnabled = this.vertexArrayEnabled;
    const naEnabled = this.normalArrayEnabled;
    const vData = this.vertexArrayData;
    const nData = this.normalArrayData;
    const vSize = this.vertexArraySize;
    const vStride = this.vertexArrayStride ? this.vertexArrayStride / 4 : vSize;
    const nStride = this.normalArrayStride ? this.normalArrayStride / 4 : 3;
    const cc = [...this.curColor];
    const cn = [...this.curNormal];
    const idxCopy = new Uint32Array(indices);

    this.cmd(() => {
      const positions = new Float32Array(count * 3);
      const normals = new Float32Array(count * 3);
      const colors = new Float32Array(count * 4);
      const texCoords = new Float32Array(count * 2);

      for (let i = 0; i < count; i++) {
        const idx = idxCopy[i];
        if (vaEnabled && vData) {
          const off = idx * vStride;
          positions[i * 3] = vData[off];
          positions[i * 3 + 1] = vData[off + 1];
          positions[i * 3 + 2] = vSize >= 3 ? vData[off + 2] : 0;
        }
        if (naEnabled && nData) {
          const off = idx * nStride;
          normals[i * 3] = nData[off];
          normals[i * 3 + 1] = nData[off + 1];
          normals[i * 3 + 2] = nData[off + 2];
        } else {
          normals[i * 3] = cn[0];
          normals[i * 3 + 1] = cn[1];
          normals[i * 3 + 2] = cn[2];
        }
        colors[i * 4] = cc[0];
        colors[i * 4 + 1] = cc[1];
        colors[i * 4 + 2] = cc[2];
        colors[i * 4 + 3] = cc[3];
      }

      this.flushImmediate(mode, positions, normals, colors, texCoords);
    });
  }

  flush(): void { this.gl.flush(); }
  finish(): void { this.gl.finish(); }
}
