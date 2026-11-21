/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

/**
 * GPU 画质增强：把 video 帧上传成 WebGL 纹理，在片元着色器里做
 * 轻量 unsharp mask + 对比度/饱和度微调，再绘制到底层 canvas。
 *
 * 相比 SVG feConvolveMatrix：
 * - 小核卷积计算量固定，不随播放器分辨率平方增长；
 * - 丢失 WebGL 上下文或帧率过低时会自动回退，避免低端设备卡死。
 */

import { getDeviceProfile } from './deviceProfile';

export interface GpuEnhanceParams {
  brightness: number;
  /** 0 关闭锐化，1 为默认强度，最高 1.6 */
  sharpen: number;
  contrast: number;
  saturation: number;
}

export interface GpuEnhancerOptions {
  /** 连续低帧率时回调，调用方负责降级 */
  onDegrade: (reason: 'fps' | 'context' | 'tainted' | 'unsupported') => void;
}

const DEFAULT_PARAMS: GpuEnhanceParams = {
  brightness: 1,
  sharpen: 0.55,
  contrast: 1.04,
  saturation: 1.05,
};

const VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;
void main() {
  v_texCoord = a_texCoord;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec2 v_texCoord;
uniform sampler2D u_image;
uniform vec2 u_texel;
uniform float u_sharpen;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;

void main() {
  vec3 c = texture2D(u_image, v_texCoord).rgb;
  vec3 n = texture2D(u_image, v_texCoord + vec2(0.0, -u_texel.y)).rgb;
  vec3 s = texture2D(u_image, v_texCoord + vec2(0.0,  u_texel.y)).rgb;
  vec3 w = texture2D(u_image, v_texCoord + vec2(-u_texel.x, 0.0)).rgb;
  vec3 e = texture2D(u_image, v_texCoord + vec2( u_texel.x, 0.0)).rgb;
  vec3 blur = (n + s + w + e) * 0.25;
  vec3 color = c + (c - blur) * u_sharpen;

  color = (color - 0.5) * u_contrast + 0.5;
  color *= u_brightness;

  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, u_saturation);

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

function compile(
  gl: WebGLRenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('GPU 画质增强着色器编译失败:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertex || !fragment) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('GPU 画质增强程序链接失败:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

/** 当前浏览器是否能真正跑 WebGL 增强 */
export function canUseGpuEnhance(): boolean {
  if (typeof document === 'undefined') return false;
  const profile = getDeviceProfile();
  return profile.webgl || profile.webgl2;
}

function clampParam(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class GpuVideoEnhancer {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private params: GpuEnhanceParams;
  private options: GpuEnhancerOptions;
  private rafId = 0;
  private destroyed = false;
  private degraded = false;
  private drawnOnce = false;
  private lastMediaTime = -1;
  private frameCount = 0;
  private fpsWindowStart = 0;
  private lastWidth = 0;
  private lastHeight = 0;
  private readonly pixelRatio: number;
  private readonly uniforms: {
    image: WebGLUniformLocation | null;
    texel: WebGLUniformLocation | null;
    sharpen: WebGLUniformLocation | null;
    brightness: WebGLUniformLocation | null;
    contrast: WebGLUniformLocation | null;
    saturation: WebGLUniformLocation | null;
  };

  private constructor(
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    gl: WebGLRenderingContext,
    program: WebGLProgram,
    options: GpuEnhancerOptions
  ) {
    this.video = video;
    this.canvas = canvas;
    this.gl = gl;
    this.program = program;
    this.options = options;
    this.params = { ...DEFAULT_PARAMS };

    const profile = getDeviceProfile();
    this.pixelRatio = profile.tier === 'low' ? 1 : 1.25;

    const container = video.parentElement;
    if (container) {
      const computed = window.getComputedStyle(container);
      if (computed.position === 'static') {
        container.style.position = 'relative';
      }
    }

    canvas.className = 'moontv-gpu-enhance';
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '1';
    canvas.style.opacity = '0';
    // 与 video 保持一致，避免拉伸后位置对不上
    canvas.style.objectFit = video.style.objectFit || 'contain';
    canvas.setAttribute('aria-hidden', 'true');

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.useProgram(program);

    // 每帧查询 uniform 位置很费 CPU，这里一次性缓存
    this.uniforms = {
      image: gl.getUniformLocation(program, 'u_image'),
      texel: gl.getUniformLocation(program, 'u_texel'),
      sharpen: gl.getUniformLocation(program, 'u_sharpen'),
      brightness: gl.getUniformLocation(program, 'u_brightness'),
      contrast: gl.getUniformLocation(program, 'u_contrast'),
      saturation: gl.getUniformLocation(program, 'u_saturation'),
    };

    this.setupGeometry();
    this.resizeIfNeeded();
    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);

    this.video.addEventListener('loadeddata', this.onLoadedData);
    this.video.addEventListener('play', this.onPlay);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    if (canvas) {
      canvas.addEventListener('webglcontextlost', this.onContextLost);
    }
  }

  static create(
    video: HTMLVideoElement,
    options: GpuEnhancerOptions
  ): GpuVideoEnhancer | null {
    if (typeof document === 'undefined' || !video) return null;

    const canvas = document.createElement('canvas');
    let gl: WebGLRenderingContext | null = null;
    try {
      gl =
        (canvas.getContext('webgl', {
          alpha: false,
          antialias: false,
          depth: false,
          stencil: false,
          premultipliedAlpha: false,
          preserveDrawingBuffer: false,
          powerPreference: 'high-performance',
        }) as WebGLRenderingContext | null) ||
        (canvas.getContext(
          'experimental-webgl'
        ) as WebGLRenderingContext | null);
    } catch {
      gl = null;
    }

    if (!gl) {
      options.onDegrade('unsupported');
      return null;
    }

    const program = createProgram(gl);
    if (!program) {
      options.onDegrade('unsupported');
      return null;
    }

    // 纹理与顶点缓冲只创建一次
    const texture = gl.createTexture();
    if (!texture) {
      options.onDegrade('unsupported');
      return null;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const enhancer = new GpuVideoEnhancer(video, canvas, gl, program, options);
    enhancer.attach();
    return enhancer;
  }

  private attach(): void {
    const parent = this.video.parentElement;
    if (!parent) {
      this.destroy();
      return;
    }
    parent.insertBefore(this.canvas, this.video.nextSibling);
  }

  private setupGeometry(): void {
    const gl = this.gl;
    const program = this.program;

    // 两个三角形覆盖整个视口
    const position = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, position);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const texCoord = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoord);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW
    );

    const aPosition = gl.getAttribLocation(program, 'a_position');
    const aTexCoord = gl.getAttribLocation(program, 'a_texCoord');

    gl.bindBuffer(gl.ARRAY_BUFFER, position);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, texCoord);
    gl.enableVertexAttribArray(aTexCoord);
    gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);
  }

  private resizeIfNeeded(): void {
    const width = Math.max(1, this.video.clientWidth || this.video.videoWidth);
    const height = Math.max(
      1,
      this.video.clientHeight || this.video.videoHeight
    );
    const drawWidth = Math.round(width * this.pixelRatio);
    const drawHeight = Math.round(height * this.pixelRatio);

    if (drawWidth === this.lastWidth && drawHeight === this.lastHeight) return;

    this.lastWidth = drawWidth;
    this.lastHeight = drawHeight;
    this.canvas.width = drawWidth;
    this.canvas.height = drawHeight;
    this.gl.viewport(0, 0, drawWidth, drawHeight);
  }

  private uploadTexture(): boolean {
    const video = this.video;
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      return false;
    }

    try {
      this.gl.texImage2D(
        this.gl.TEXTURE_2D,
        0,
        this.gl.RGB,
        this.gl.RGB,
        this.gl.UNSIGNED_BYTE,
        video
      );
      return true;
    } catch (err) {
      // 跨域未带 CORS 的源会把 canvas 标记为 tainted，只能放弃
      console.warn('GPU 画质增强无法读取视频帧:', err);
      this.degrade('tainted');
      return false;
    }
  }

  private draw(): void {
    const gl = this.gl;
    const program = this.program;
    gl.useProgram(program);

    const sharpen = clampParam(this.params.sharpen, 0, 1.6);
    const brightness = clampParam(this.params.brightness, 0.2, 1.6);
    const contrast = clampParam(this.params.contrast, 0.8, 1.2);
    const saturation = clampParam(this.params.saturation, 0.8, 1.3);

    const uniforms = this.uniforms;
    gl.uniform1i(uniforms.image, 0);
    gl.uniform2f(
      uniforms.texel,
      1 / Math.max(1, this.video.videoWidth),
      1 / Math.max(1, this.video.videoHeight)
    );
    gl.uniform1f(uniforms.sharpen, sharpen);
    gl.uniform1f(uniforms.brightness, brightness);
    gl.uniform1f(uniforms.contrast, contrast);
    gl.uniform1f(uniforms.saturation, saturation);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    if (!this.drawnOnce) {
      this.drawnOnce = true;
      this.canvas.style.opacity = '1';
      // 首帧画出来后再藏 video，避免增强不可用时黑屏
      if (sharpen > 0.001) {
        this.video.style.visibility = 'hidden';
      }
    }
  }

  private loop(): void {
    if (this.destroyed) return;
    this.rafId = requestAnimationFrame(this.loop);

    if (document.hidden || this.video.ended) return;

    const changed = this.video.currentTime !== this.lastMediaTime;
    this.lastMediaTime = this.video.currentTime;

    // 暂停且画面没变时不重复上传纹理，省 GPU
    if (this.video.paused && this.drawnOnce && !changed) return;

    this.resizeIfNeeded();
    if (!this.uploadTexture()) return;
    this.draw();

    if (!this.video.paused) {
      this.trackFps();
    }
  }

  private trackFps(): void {
    const now = performance.now();
    if (this.fpsWindowStart === 0) {
      this.fpsWindowStart = now;
      this.frameCount = 0;
      return;
    }

    this.frameCount += 1;
    const elapsed = now - this.fpsWindowStart;
    if (elapsed < 2000) return;

    const fps = (this.frameCount * 1000) / elapsed;
    this.fpsWindowStart = now;
    this.frameCount = 0;

    // 持续低于 20fps 说明 GPU 增强拖垮了播放，回退到兼容模式
    if (fps > 0 && fps < 20) {
      this.degrade('fps');
    }
  }

  private degrade(reason: 'fps' | 'context' | 'tainted' | 'unsupported'): void {
    if (this.degraded) return;
    this.degraded = true;
    this.options.onDegrade(reason);
    this.destroy();
  }

  private onLoadedData = () => {
    this.drawnOnce = false;
  };

  private onPlay = () => {
    this.fpsWindowStart = 0;
    this.frameCount = 0;
  };

  private onVisibilityChange = () => {
    if (!document.hidden) {
      this.fpsWindowStart = 0;
      this.frameCount = 0;
    }
  };

  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.degrade('context');
  };

  update(params: Partial<GpuEnhanceParams>): void {
    this.params = {
      ...this.params,
      ...params,
      brightness: clampParam(
        params.brightness ?? this.params.brightness,
        0.2,
        1.6
      ),
      sharpen: clampParam(params.sharpen ?? this.params.sharpen, 0, 1.6),
    };

    // 关闭锐化时把 video 放回来，canvas 只作为过渡层
    if (this.params.sharpen > 0.001 && this.drawnOnce) {
      this.video.style.visibility = 'hidden';
    } else if (this.video.style.visibility === 'hidden') {
      this.video.style.visibility = '';
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    cancelAnimationFrame(this.rafId);
    this.video.removeEventListener('loadeddata', this.onLoadedData);
    this.video.removeEventListener('play', this.onPlay);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);

    try {
      this.video.style.visibility = '';
      this.canvas.remove();
      const lose = this.gl.getExtension('WEBGL_lose_context');
      lose?.loseContext();
    } catch {
      /* 释放失败不影响播放 */
    }
  }
}
