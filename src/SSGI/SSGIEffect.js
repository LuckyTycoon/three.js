﻿import { Effect, Selection } from "postprocessing"
import { UniformsUtils } from "three"
import {
	EquirectangularReflectionMapping,
	LinearMipMapLinearFilter,
	NoToneMapping,
	ShaderChunk,
	ShaderLib,
	sRGBEncoding,
	Uniform,
	WebGLRenderTarget
} from "three"
import { SSGIPass } from "./pass/SSGIPass.js"
import compose from "./shader/compose.frag"
import denoiseCompose from "./shader/denoiseCompose.frag"
import denoiseComposeFunctions from "./shader/denoiseComposeFunctions.frag"
import utils from "./shader/utils.frag"
import { defaultSSGIOptions } from "./SSGIOptions"
import { SVGF } from "./SVGF.js"
import { getMaxMipLevel } from "./utils/Utils.js"

const finalFragmentShader = compose.replace("#include <utils>", utils)

export const createGlobalDisableIblRadianceUniform = () => {
	if (!ShaderChunk.envmap_physical_pars_fragment.includes("iblRadianceDisabled")) {
		ShaderChunk.envmap_physical_pars_fragment = ShaderChunk.envmap_physical_pars_fragment.replace(
			"vec3 getIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {",
			/* glsl */ `
		uniform bool iblRadianceDisabled;
	
		vec3 getIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
		 if(iblRadianceDisabled) return vec3(0.);
		`
		)
	}

	if ("iblRadianceDisabled" in ShaderLib.physical.uniforms) return ShaderLib.physical.uniforms["iblRadianceDisabled"]

	const globalIblRadianceDisabledUniform = {
		value: false
	}

	ShaderLib.physical.uniforms.iblRadianceDisabled = globalIblRadianceDisabledUniform

	const { clone } = UniformsUtils
	UniformsUtils.clone = uniforms => {
		const result = clone(uniforms)

		if ("iblRadianceDisabled" in uniforms) {
			result.iblRadianceDisabled = globalIblRadianceDisabledUniform
		}

		return result
	}

	return globalIblRadianceDisabledUniform
}

export const createGlobalDisableIblIradianceUniform = () => {
	if (!ShaderChunk.envmap_physical_pars_fragment.includes("iblIrradianceDisabled")) {
		ShaderChunk.envmap_physical_pars_fragment = ShaderChunk.envmap_physical_pars_fragment.replace(
			"vec3 getIBLIrradiance( const in vec3 normal ) {",
			/* glsl */ `
			uniform bool iblIrradianceDisabled;
		
			vec3 getIBLIrradiance( const in vec3 normal ) {
			 if(iblIrradianceDisabled) return vec3(0.);
			`
		)
	}

	if ("iblIrradianceDisabled" in ShaderLib.physical.uniforms)
		return ShaderLib.physical.uniforms["iblIrradianceDisabled"]

	const globalIblIrradianceDisabledUniform = {
		value: false
	}

	ShaderLib.physical.uniforms.iblIrradianceDisabled = globalIblIrradianceDisabledUniform

	const { clone } = UniformsUtils
	UniformsUtils.clone = uniforms => {
		const result = clone(uniforms)

		if ("iblIrradianceDisabled" in uniforms) {
			result.iblIrradianceDisabled = globalIblIrradianceDisabledUniform
		}

		return result
	}

	return globalIblIrradianceDisabledUniform
}

const globalIblIrradianceDisabledUniform = createGlobalDisableIblIradianceUniform()
const globalIblRadianceDisabledUniform = createGlobalDisableIblRadianceUniform()

export class SSGIEffect extends Effect {
	selection = new Selection()

	/**
	 * @param {THREE.Scene} scene The scene of the SSGI effect
	 * @param {THREE.Camera} camera The camera with which SSGI is being rendered
	 * @param {SSGIOptions} [options] The optional options for the SSGI effect
	 */
	constructor(scene, camera, options = defaultSSGIOptions) {
		options = { ...defaultSSGIOptions, ...options }

		super("SSGIEffect", finalFragmentShader, {
			type: "FinalSSGIMaterial",
			uniforms: new Map([
				["inputTexture", new Uniform(null)],
				["sceneTexture", new Uniform(null)],
				["depthTexture", new Uniform(null)],
				["toneMapping", new Uniform(NoToneMapping)]
			])
		})

		this._scene = scene
		this._camera = camera

		this.svgf = new SVGF(scene, camera, denoiseCompose, denoiseComposeFunctions, options)

		// ssgi pass
		this.ssgiPass = new SSGIPass(this, options)
		this.svgf.setInputTexture(this.ssgiPass.texture)
		this.svgf.setSpecularTexture(this.ssgiPass.specularTexture)

		// the denoiser always uses the same G-buffers as the SSGI pass
		const denoisePassUniforms = this.svgf.denoisePass.fullscreenMaterial.uniforms
		denoisePassUniforms.depthTexture.value = this.ssgiPass.depthTexture
		denoisePassUniforms.normalTexture.value = this.ssgiPass.normalTexture

		this.svgf.setJitteredGBuffers(this.ssgiPass.depthTexture, this.ssgiPass.normalTexture)

		// unless overridden, SVGF's temporal resolve pass also uses the same G-buffers as the SSGI pass
		// when TRAA is being used, the temporal resolve pass needs to use different G-buffers without jittering
		this.svgf.setNonJitteredGBuffers(this.ssgiPass.depthTexture, this.ssgiPass.normalTexture)
		this.svgf.setDiffuseTexture(this.ssgiPass.diffuseTexture)

		// patch the denoise pass

		this.svgf.denoisePass.fullscreenMaterial.fragmentShader =
			/* glsl */ `
		uniform sampler2D directLightTexture;
		uniform float jitter;
		uniform float jitterRoughness;
		` +
			this.svgf.denoisePass.fullscreenMaterial.fragmentShader
				.replace(
					"float roughness = normalTexel.a;",
					"float roughness = min(1., jitter + jitterRoughness * normalTexel.a);"
				)
				.replace(
					"float neighborRoughness = neighborNormalTexel.a;",
					"float neighborRoughness = min(1., jitter + jitterRoughness * neighborNormalTexel.a);"
				)

		this.svgf.denoisePass.fullscreenMaterial.uniforms = {
			...this.svgf.denoisePass.fullscreenMaterial.uniforms,
			...{
				directLightTexture: new Uniform(null),
				jitter: new Uniform(0),
				jitterRoughness: new Uniform(0)
			}
		}

		// temporal resolve pass
		this.svgf.svgfTemporalResolvePass.fullscreenMaterial.fragmentShader =
			/* glsl */ `
			uniform float jitter;
			uniform float jitterRoughness;
		` +
			this.svgf.svgfTemporalResolvePass.fullscreenMaterial.fragmentShader.replace(
				"float roughness = inputTexel.a;",
				"float roughness = min(1., jitter + jitterRoughness * inputTexel.a);"
			)

		this.svgf.svgfTemporalResolvePass.fullscreenMaterial.uniforms = {
			...this.svgf.svgfTemporalResolvePass.fullscreenMaterial.uniforms,
			...{
				jitter: new Uniform(0),
				jitterRoughness: new Uniform(0)
			}
		}

		if (options.sunMultiplier > 0) {
			this.ssgiPass.fullscreenMaterial.defines.sunMultiplier = options.sunMultiplier.toPrecision(5)
			this.ssgiPass.fullscreenMaterial.defines.useDirectLight = ""
			this.svgf.denoisePass.fullscreenMaterial.defines.useDirectLight = ""
		}

		this.svgf.denoisePass.fullscreenMaterial.uniforms.diffuseTexture.value = this.ssgiPass.diffuseTexture

		this.lastSize = {
			width: options.width,
			height: options.height,
			resolutionScale: options.resolutionScale
		}

		this.sceneRenderTarget = new WebGLRenderTarget(1, 1, {
			encoding: sRGBEncoding
		})

		this.setSize(options.width, options.height)

		this.makeOptionsReactive(options)
	}

	makeOptionsReactive(options) {
		let needsUpdate = false

		if (options.reflectionsOnly) this.svgf.svgfTemporalResolvePass.fullscreenMaterial.defines.reflectionsOnly = ""

		const ssgiPassFullscreenMaterialUniforms = this.ssgiPass.fullscreenMaterial.uniforms
		const ssgiPassFullscreenMaterialUniformsKeys = Object.keys(ssgiPassFullscreenMaterialUniforms)

		for (const key of Object.keys(options)) {
			Object.defineProperty(this, key, {
				get() {
					return options[key]
				},
				set(value) {
					if (options[key] === value && needsUpdate) return

					options[key] = value

					switch (key) {
						case "resolutionScale":
							this.setSize(this.lastSize.width, this.lastSize.height)
							break

						case "denoiseIterations":
							this.svgf.denoisePass.iterations = value
							break

						case "denoiseKernel":
						case "denoiseDiffuse":
						case "denoiseSpecular":
						case "depthPhi":
						case "normalPhi":
						case "roughnessPhi":
							this.svgf.denoisePass.fullscreenMaterial.uniforms[key].value = value
							break

						// defines
						case "steps":
						case "refineSteps":
						case "spp":
							this.ssgiPass.fullscreenMaterial.defines[key] = parseInt(value)
							this.ssgiPass.fullscreenMaterial.needsUpdate = needsUpdate
							break

						case "missedRays":
							if (value) {
								this.ssgiPass.fullscreenMaterial.defines.missedRays = ""
							} else {
								delete this.ssgiPass.fullscreenMaterial.defines.missedRays
							}

							this.ssgiPass.fullscreenMaterial.needsUpdate = needsUpdate
							break

						case "correctionRadius":
							this.svgf.svgfTemporalResolvePass.fullscreenMaterial.defines.correctionRadius = Math.round(value)

							this.svgf.svgfTemporalResolvePass.fullscreenMaterial.needsUpdate = needsUpdate
							break

						case "blend":
						case "correction":
							this.svgf.svgfTemporalResolvePass.fullscreenMaterial.uniforms[key].value = value
							break

						case "distance":
							ssgiPassFullscreenMaterialUniforms.rayDistance.value = value
							break

						case "jitter":
						case "jitterRoughness":
							ssgiPassFullscreenMaterialUniforms[key].value = value

							this.svgf.denoisePass.fullscreenMaterial.uniforms[key].value = value
							this.svgf.svgfTemporalResolvePass.fullscreenMaterial.uniforms[key].value = value
							break

						// must be a uniform
						default:
							if (ssgiPassFullscreenMaterialUniformsKeys.includes(key)) {
								ssgiPassFullscreenMaterialUniforms[key].value = value
							}
					}
				}
			})

			// apply all uniforms and defines
			this[key] = options[key]
		}

		needsUpdate = true
	}

	initialize(renderer, ...args) {
		super.initialize(renderer, ...args)
		this.ssgiPass.initialize(renderer, ...args)
	}

	setSize(width, height, force = false) {
		if (width === undefined && height === undefined) return
		if (
			!force &&
			width === this.lastSize.width &&
			height === this.lastSize.height &&
			this.resolutionScale === this.lastSize.resolutionScale
		)
			return

		this.ssgiPass.setSize(width, height)
		this.svgf.setSize(width, height)
		this.sceneRenderTarget.setSize(width, height)

		this.lastSize = {
			width,
			height,
			resolutionScale: this.resolutionScale
		}
	}

	setVelocityPass(velocityPass) {
		this.ssgiPass.fullscreenMaterial.uniforms.velocityTexture.value = velocityPass.texture
		this.svgf.svgfTemporalResolvePass.fullscreenMaterial.uniforms.velocityTexture.value = velocityPass.texture

		this.svgf.setNonJitteredGBuffers(velocityPass.depthTexture, velocityPass.normalTexture)
	}

	dispose() {
		super.dispose()

		this.ssgiPass.dispose()
		this.svgf.dispose()
	}

	keepEnvMapUpdated() {
		const ssgiMaterial = this.ssgiPass.fullscreenMaterial

		if (ssgiMaterial.uniforms.envMap.value !== this._scene.environment) {
			if (this._scene.environment?.mapping === EquirectangularReflectionMapping) {
				ssgiMaterial.uniforms.envMap.value = this._scene.environment

				if (!this._scene.environment.generateMipmaps) {
					this._scene.environment.generateMipmaps = true
					this._scene.environment.minFilter = LinearMipMapLinearFilter
					this._scene.environment.magFilter = LinearMipMapLinearFilter
					this._scene.environment.needsUpdate = true
				}

				const maxEnvMapMipLevel = getMaxMipLevel(this._scene.environment)
				ssgiMaterial.uniforms.maxEnvMapMipLevel.value = maxEnvMapMipLevel

				ssgiMaterial.defines.USE_ENVMAP = ""
			} else {
				ssgiMaterial.uniforms.envMap.value = null
				delete ssgiMaterial.defines.USE_ENVMAP
			}

			ssgiMaterial.needsUpdate = true
		}
	}

	update(renderer, inputBuffer) {
		this.keepEnvMapUpdated()

		const renderScene = false
		const sceneBuffer = renderScene ? this.sceneRenderTarget : inputBuffer

		if (renderScene) {
			renderer.setRenderTarget(this.sceneRenderTarget)

			const children = []

			this._scene.traverseVisible(c => {
				if (c.isScene) return

				c._wasVisible = true

				c.visible = c.constructor.name === "GroundProjectedEnv" || this.selection.has(c)

				if (!c.visible) children.push(c)
			})

			renderer.render(this._scene, this._camera)

			for (const c of children) {
				c.visible = true
				delete c._wasVisible
			}
		}

		this.ssgiPass.fullscreenMaterial.uniforms.directLightTexture.value = sceneBuffer.texture
		this.svgf.denoisePass.fullscreenMaterial.uniforms.directLightTexture.value = sceneBuffer.texture

		this.ssgiPass.render(renderer)
		this.svgf.render(renderer)

		this.uniforms.get("inputTexture").value = this.svgf.texture
		this.uniforms.get("sceneTexture").value = sceneBuffer.texture
		this.uniforms.get("depthTexture").value = this.ssgiPass.depthTexture
		this.uniforms.get("toneMapping").value = renderer.toneMapping

		const fullGi = !this.diffuseOnly && !this.specularOnly

		globalIblIrradianceDisabledUniform.value = fullGi || this.diffuseOnly === true
		globalIblRadianceDisabledUniform.value = fullGi || this.specularOnly == true

		cancelAnimationFrame(this.rAF2)
		cancelAnimationFrame(this.rAF)

		this.rAF = requestAnimationFrame(() => {
			this.rAF2 = requestAnimationFrame(() => {
				globalIblIrradianceDisabledUniform.value = false
				globalIblRadianceDisabledUniform.value = false
			})
		})
	}
}
