<script setup lang="ts">
import {
  computed,
  inject,
  onMounted,
  onScopeDispose,
  ref,
  watch,
  watchEffect,
} from 'vue'
import {
  VUE_QUERY_CLIENT,
  onlineManager,
  useQueryClient,
} from '@tanstack/vue-query'
import { TanstackQueryDevtoolsPanel } from '@tanstack/query-devtools'
import type { QueryClient } from '@tanstack/vue-query'
import type { DevtoolsPanelOptions } from './types'

const props = defineProps<DevtoolsPanelOptions>()
const style = computed<any>(() => {
  return {
    height: '500px',
    ...props.style,
  }
})

const div = ref<HTMLElement>()
const injectedClient = props.client
  ? inject<QueryClient | undefined>(VUE_QUERY_CLIENT, undefined)
  : useQueryClient()
const client = computed(() => props.client || injectedClient)
const devtools = new TanstackQueryDevtoolsPanel({
  client: client.value!,
  queryFlavor: 'Vue Query',
  version: '5',
  onlineManager,
  buttonPosition: 'bottom-left',
  position: 'bottom',
  initialIsOpen: true,
  errorTypes: props.errorTypes,
  styleNonce: props.styleNonce,
  shadowDOMTarget: props.shadowDOMTarget,
  hideDisabledQueries: props.hideDisabledQueries,
  onClose: props.onClose,
  theme: props.theme,
})
let isMounted = false

// The panel must never keep rendering a client the app has replaced, so it
// unmounts while no client is available.
watch(
  client,
  (current) => {
    if (!current) {
      if (isMounted) {
        devtools.unmount()
        isMounted = false
      }
      return
    }
    devtools.setClient(current)
    if (!isMounted && div.value) {
      devtools.mount(div.value)
      isMounted = true
    }
  },
  { flush: 'sync' },
)

watchEffect(() => {
  devtools.setOnClose(props.onClose ?? (() => {}))
  devtools.setErrorTypes(props.errorTypes || [])
  devtools.setTheme(props.theme)
})

onMounted(() => {
  if (client.value && !isMounted) {
    devtools.mount(div.value as HTMLElement)
    isMounted = true
  }
  onScopeDispose(() => {
    if (isMounted) {
      devtools.unmount()
      isMounted = false
    }
  })
})
</script>

<template>
  <div :style="style" class="tsqd-parent-container" ref="div"></div>
</template>
