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
import { TanstackQueryDevtools } from '@tanstack/query-devtools'
import type { QueryClient } from '@tanstack/vue-query'
import type { DevtoolsOptions } from './types'

const props = defineProps<DevtoolsOptions>()

const div = ref<HTMLElement>()
const injectedClient = props.client
  ? inject<QueryClient | undefined>(VUE_QUERY_CLIENT, undefined)
  : useQueryClient()
const client = computed(() => props.client || injectedClient)
const devtools = new TanstackQueryDevtools({
  client: client.value!,
  queryFlavor: 'Vue Query',
  version: '5',
  onlineManager,
  buttonPosition: props.buttonPosition,
  position: props.position,
  initialIsOpen: props.initialIsOpen,
  errorTypes: props.errorTypes,
  styleNonce: props.styleNonce,
  shadowDOMTarget: props.shadowDOMTarget,
  hideDisabledQueries: props.hideDisabledQueries,
  theme: props.theme,
})
let isMounted = false

// The devtools must never keep rendering a client the app has replaced, so
// they unmount while no client is available.
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
  devtools.setButtonPosition(props.buttonPosition || 'bottom-right')
  devtools.setPosition(props.position || 'bottom')
  devtools.setInitialIsOpen(props.initialIsOpen)
  devtools.setErrorTypes(props.errorTypes || [])
  devtools.setTheme(props.theme || 'system')
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
  <div class="tsqd-parent-container" ref="div"></div>
</template>
